import {
	FLEET_BROWSER_CAPABILITY,
	FLEET_GPU_CAPABILITY,
	FLEET_PUSH_CAPABILITY,
	FLEET_PUSH_MIN_GIT_VERSION
} from '@ever-works/contracts';
import type { BrowserProbeIo } from './browser-probe';
import type { ModelCliPaths } from './executors/model-cli';
import { detectGpu } from './gpu-probe';
import type { NodeHousekeepingReport } from './housekeeping-report';
import type { WorkerHealth } from './worker-health';
import {
	MAX_CAPABILITY_TAG_LENGTH,
	MAX_CAPABILITY_TAGS,
	MAX_PLATFORM_LENGTH,
	MAX_VERSION_LENGTH,
	type NodeSelfDescription
} from './types';

/**
 * Capability detection.
 *
 * Capability tags are the scheduling hints the platform uses to decide what a
 * node may be given (PRD §4.5 / §6.2). They are re-detected on every heartbeat
 * so installing Docker or Git on a running node is picked up without a
 * re-enroll.
 *
 * Everything is injected — the command runner, the environment snapshot — so
 * the whole matrix is unit-testable without touching the host.
 */

/** Minimal command abstraction, mirroring `apps/desktop`'s `CommandRunner`. */
export interface CommandRunner {
	run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** Host facts the detector needs, snapshotted so tests can drive every branch. */
export interface CapabilityEnvironment {
	/** `process.platform` — win32 / darwin / linux / … */
	platform: string;
	/** `process.arch` — x64 / arm64 / … */
	arch: string;
	/** `process.version` — e.g. `v22.11.0`. */
	nodeVersion: string;
	/** Whether a graphical display is available (headed browser automation). */
	hasDisplay: boolean;
	/**
	 * Absolute path of a browser executable this machine can actually
	 * launch, or null. Resolved by {@link resolveBrowserPath} — the SAME
	 * function `browser-check` uses to spawn — so the `browser` tag and
	 * the executor can never disagree about what is installed.
	 */
	browserPath?: string | null;
	/**
	 * Absolute paths of the model CLIs this machine can drive for an
	 * `agent-task` (agent execution v2), resolved once at startup by
	 * `resolveModelCliPaths`. A resolved path is what turns the
	 * `claude-code` / `codex` tag on — the SAME path the model step
	 * spawns, so the tag and the executor can never disagree.
	 */
	modelCli?: ModelCliPaths;
	/** Startup log lines explaining each model-CLI decision. */
	modelCliNotes?: string[];
}

/**
 * Capabilities every enrolled node offers by construction: it can host a local
 * terminal session (`pty-local` / `terminal-stream`) and a local workspace
 * (`local-workspace`) for worktree-per-Task isolation.
 */
export const BASE_CAPABILITIES = ['terminal', 'workspace'] as const;

/** `process.platform` values that always have a display when a session exists. */
const ALWAYS_DISPLAYED_PLATFORMS = new Set(['win32', 'darwin']);

/** Extract the major version from a `process.version`-style string. */
export function nodeMajor(nodeVersion: string): number | null {
	const match = /^v?(\d+)/.exec(nodeVersion.trim());
	if (!match) {
		return null;
	}
	const major = Number.parseInt(match[1], 10);
	return Number.isFinite(major) ? major : null;
}

/**
 * `os/arch` string for the node's `platform` field (server caps it at 64
 * characters; we cap here too so the stored value matches what we sent).
 */
export function describePlatform(environment: CapabilityEnvironment): string {
	return `${environment.platform}/${environment.arch}`.slice(0, MAX_PLATFORM_LENGTH);
}

/**
 * Whether the host can drive a headed browser. Windows and macOS sessions
 * always can; on Linux/BSD it depends on an X11 or Wayland display being
 * exported to this process.
 */
export function detectDisplay(platform: string, env: Record<string, string | undefined>): boolean {
	if (ALWAYS_DISPLAYED_PLATFORMS.has(platform)) {
		return true;
	}
	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Build a {@link CapabilityEnvironment} from a process-like object.
 *
 * `browserProbe` is optional so pure-logic callers (and every test) can
 * skip filesystem access; when it is supplied the resolved executable
 * path is what turns the `browser` tag on.
 */
export function readEnvironment(
	processLike: {
		platform: string;
		arch: string;
		version: string;
		env: Record<string, string | undefined>;
	},
	browserProbe?: (io: BrowserProbeIo) => string | null,
	probeIo?: Pick<BrowserProbeIo, 'fileExists' | 'lookupOnPath'>
): CapabilityEnvironment {
	const environment: CapabilityEnvironment = {
		platform: processLike.platform,
		arch: processLike.arch,
		nodeVersion: processLike.version,
		hasDisplay: detectDisplay(processLike.platform, processLike.env)
	};
	if (browserProbe && probeIo) {
		environment.browserPath = browserProbe({
			platform: processLike.platform,
			env: processLike.env,
			fileExists: probeIo.fileExists,
			...(probeIo.lookupOnPath ? { lookupOnPath: probeIo.lookupOnPath } : {})
		});
	}
	return environment;
}

/**
 * Apply the server's sanitization rules locally: trim, truncate to 32
 * characters, drop empties, dedupe, cap at 16 tags. Keeping this in sync with
 * `sanitizeCapabilities` in `fleet.service.ts` means what the node reports is
 * exactly what the platform stores — no silent truncation surprises in Fleet.
 */
export function normalizeCapabilities(tags: readonly (string | undefined | null)[]): string[] {
	const out: string[] = [];
	for (const raw of tags) {
		if (typeof raw !== 'string') {
			continue;
		}
		const tag = raw.trim().slice(0, MAX_CAPABILITY_TAG_LENGTH);
		if (!tag || out.includes(tag)) {
			continue;
		}
		out.push(tag);
		if (out.length >= MAX_CAPABILITY_TAGS) {
			break;
		}
	}
	return out;
}

/** True when `<tool> --version` exits 0. Any spawn failure counts as absent. */
async function hasTool(runner: CommandRunner, command: string): Promise<boolean> {
	try {
		const result = await runner.run(command, ['--version']);
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * What this machine's Git can do (self-build slice AM).
 *
 * `present` keeps the exact meaning the `git` tag has always had:
 * `git --version` exited 0. `scopedPush` is the new, narrower promise —
 * this Git accepts configuration through `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_<n>`, which is how the platform's per-run push
 * credential is installed. Git 2.31 (March 2021) introduced it.
 *
 * A version this probe cannot PARSE reports `scopedPush: false`. That
 * fails closed on purpose: guessing "probably new enough" would put the
 * `git-push` tag on a machine whose push would silently fall through to
 * its own ambient credential helper, which is the exact hole the tag
 * exists to keep work away from.
 */
export async function probeGit(runner: CommandRunner): Promise<{ present: boolean; scopedPush: boolean }> {
	let stdout = '';
	try {
		const result = await runner.run('git', ['--version']);
		if (result.code !== 0) return { present: false, scopedPush: false };
		stdout = result.stdout ?? '';
	} catch {
		return { present: false, scopedPush: false };
	}
	return { present: true, scopedPush: gitSupportsScopedPush(stdout) };
}

/**
 * Minimum Git that accepts environment-carried configuration, parsed from
 * the CONTRACTS constant rather than restated here: the platform's own
 * documentation and this probe must name the same version, and two
 * literals are two chances to drift.
 */
const MIN_SCOPED_PUSH_GIT: readonly [number, number] = (() => {
	const parts = FLEET_PUSH_MIN_GIT_VERSION.split('.').map((part) => Number.parseInt(part, 10));
	return [parts[0] ?? 2, parts[1] ?? 31];
})();

/**
 * Parse `git version 2.53.0.windows.1` and compare against 2.31.
 *
 * Exported so the rule is testable on its own — the version string a
 * fleet machine reports is the one fact this whole capability turns on,
 * and it varies by platform packaging far more than any other probe here.
 */
export function gitSupportsScopedPush(versionOutput: string): boolean {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(versionOutput ?? ''));
	if (!match) return false;
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
	if (major !== MIN_SCOPED_PUSH_GIT[0]) return major > MIN_SCOPED_PUSH_GIT[0];
	return minor >= MIN_SCOPED_PUSH_GIT[1];
}

/**
 * Detect this machine's capability tags:
 * `os:<platform>`, `arch:<arch>`, `node:<major>`, the always-on
 * `terminal`/`workspace`, plus `docker`, `git`, `git-push`, `display`,
 * `browser`, `gpu` and `gpu:<vendor>` when present.
 *
 * Two rules govern what may appear here:
 *
 *   1. **A tag is a promise the node can keep.** `browser` is emitted
 *      only when a browser executable was actually resolved — the same
 *      path the `browser-check` executor will spawn. A tag nothing
 *      backs would route real work to a machine that cannot do it.
 *   2. **Detection never fails the beat.** Every probe swallows its own
 *      errors; a missing tool means a missing tag, not a missing
 *      heartbeat.
 */
export async function detectCapabilities(runner: CommandRunner, environment: CapabilityEnvironment): Promise<string[]> {
	const [docker, git, gpu] = await Promise.all([
		hasTool(runner, 'docker'),
		probeGit(runner),
		detectGpu(runner, environment.platform)
	]);
	const major = nodeMajor(environment.nodeVersion);
	const hasBrowser = typeof environment.browserPath === 'string' && environment.browserPath.length > 0;
	const hasClaude =
		typeof environment.modelCli?.['claude-code'] === 'string' && environment.modelCli['claude-code'].length > 0;
	const hasCodex = typeof environment.modelCli?.codex === 'string' && environment.modelCli.codex.length > 0;

	return normalizeCapabilities([
		`os:${environment.platform}`,
		`arch:${environment.arch}`,
		major === null ? null : `node:${major}`,
		...BASE_CAPABILITIES,
		docker ? 'docker' : null,
		git.present ? 'git' : null,
		// Scoped push (self-build slice AM): the SAME fact the push
		// depends on turns the tag on — a Git that accepts the per-run
		// credential through its environment. A machine whose Git is too
		// old is not "a machine that pushes a bit differently"; it is a
		// machine whose push would fall back to the operator's own
		// long-lived credential helper, which is the thing this tag keeps
		// work away from.
		git.scopedPush ? FLEET_PUSH_CAPABILITY : null,
		environment.hasDisplay ? 'display' : null,
		hasBrowser ? FLEET_BROWSER_CAPABILITY : null,
		// Agent execution v2 — a model CLI the node can actually spawn.
		// Same rule as `browser`: the tag is backed by a resolved path.
		hasClaude ? 'claude-code' : null,
		hasCodex ? 'codex' : null,
		gpu ? FLEET_GPU_CAPABILITY : null,
		// Vendor is a second, narrower tag rather than a replacement:
		// a job that needs "any accelerator" must not have to enumerate
		// vendors, and one that needs CUDA must be able to say so.
		gpu ? `${FLEET_GPU_CAPABILITY}:${gpu.vendor}` : null
	]);
}

/**
 * Tag families that describe WHAT this machine IS rather than what it OFFERS.
 * They are never withheld: the scheduler needs `os:`/`arch:`/`node:` to place
 * work correctly, and hiding them would produce silent mis-placement rather
 * than a smaller offer.
 */
const IDENTITY_TAG_PREFIXES = ['os:', 'arch:', 'node:'] as const;

/** True when a tag is machine identity (always advertised) rather than an offer. */
export function isIdentityCapability(tag: string): boolean {
	return IDENTITY_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

/**
 * Tags that are detected but NOT offered as an operator choice.
 *
 * `git-push` (self-build slice AM) is here because withholding it is not
 * a narrower offer, it is a broken one: every `agent-task` the platform
 * dispatches requires it, so a node that hid the tag would simply stop
 * doing the work it already does — and an operator whose config predates
 * the tag has, by definition, not opted into it. Detection still decides
 * whether it appears at all; the opt-in only decides what a machine
 * ADVERTISES from what it can do, and there is nothing to opt out of
 * here that does not also opt out of fleet runs entirely.
 */
const NON_SELECTABLE_TAGS = new Set<string>([FLEET_PUSH_CAPABILITY]);

/**
 * True when a tag is advertised whatever the operator selected: machine
 * identity, or a capability whose absence would only strand work.
 */
export function isAlwaysAdvertisedCapability(tag: string): boolean {
	return isIdentityCapability(tag) || NON_SELECTABLE_TAGS.has(tag);
}

/**
 * The tags an operator is actually allowed to choose between — everything the
 * detector found minus the identity tags. This is what the wizard's capability
 * step renders as checkboxes.
 */
export function selectableCapabilities(detected: readonly string[]): string[] {
	return detected.filter((tag) => !isAlwaysAdvertisedCapability(tag));
}

/**
 * Apply the operator's capability opt-in (PRD §3.2 step 3).
 *
 * Semantics, in order of precedence:
 *   1. `selection === undefined | null` → advertise everything detected
 *      (byte-identical to the pre-selection behaviour, so an older config
 *      keeps working).
 *   2. otherwise → advertise identity tags plus the intersection of
 *      `detected` and `selection`.
 *
 * The intersection direction matters: a selection can only ever SHRINK what
 * the node offers. An operator cannot advertise `docker` on a machine without
 * Docker by editing the config, and — the case that motivates this — a machine
 * that later gains Docker does not start attracting Docker work unless its
 * owner opted into that tag.
 */
export function applyCapabilitySelection(detected: readonly string[], selection?: readonly string[] | null): string[] {
	if (selection === undefined || selection === null) {
		return normalizeCapabilities([...detected]);
	}
	const chosen = new Set(normalizeCapabilities([...selection]));
	return normalizeCapabilities(detected.filter((tag) => isAlwaysAdvertisedCapability(tag) || chosen.has(tag)));
}

/**
 * What {@link describeSelf} returns.
 *
 * The three ORIGINAL fields stay required — callers dereference
 * `platform` and `capabilities` directly, and they are always computed.
 * The telemetry fields stay optional, because "absent" is a meaningful
 * value on the wire: the server reads it as "leave the stored reading
 * alone". This used to be `Required<NodeSelfDescription>`, which stopped
 * being expressible the moment a genuinely optional field joined the
 * contract.
 */
export type NodeSelfDescriptionPayload = NodeSelfDescription &
	Required<Pick<NodeSelfDescription, 'platform' | 'version' | 'capabilities'>>;

/**
 * Optional telemetry sources for {@link describeSelf}.
 *
 * Injected rather than probed inline so the description stays testable
 * without a host, and OPTIONAL so every existing caller — and every
 * older build of this app — produces exactly the description it did
 * before these fields existed.
 */
export interface SelfDescriptionTelemetry {
	/** Agent-CLI probe, e.g. `detectAgentCliVersion(runner)`. */
	cliVersion?: () => Promise<string | null> | string | null;
	/** Free-disk probe for the node's workspace volume. */
	diskFreeBytes?: () => Promise<number | null> | number | null;
	/**
	 * Which account / seat the agent CLI is logged in as (fleet cost
	 * accounting, EW-777), e.g. `detectModelIdentity(runner, paths)`. A
	 * display label, never a credential.
	 */
	modelIdentity?: () => Promise<string | null> | string | null;
	/**
	 * What the worker loop is doing (fleet health signals, EW-776), via
	 * `describeWorkerHealth(worker.getState())`.
	 *
	 * A probe like the others — absent on a visibility-only node that has
	 * no worker at all, and a null return is an ABSENT field rather than a
	 * reported "unknown". That matters: the server treats an absent field
	 * as "leave the stored value alone", so a probe that momentarily fails
	 * does not wipe the quarantine an operator is currently reading.
	 */
	workerHealth?: () => Promise<WorkerHealth | null> | WorkerHealth | null;
	/**
	 * What this machine is doing about its own disk (node housekeeping,
	 * EW-803), via `NodeHousekeepingReporter.describe()` — the floor it
	 * enforces on itself, and what its last reclaim sweep retained and
	 * freed.
	 *
	 * A probe like the others: absent on a visibility-only node, which
	 * has neither a floor nor a reaper. Every field inside the report is
	 * itself optional, so a worker whose first sweep has not run yet
	 * reports the floor alone.
	 */
	housekeeping?: () => Promise<NodeHousekeepingReport | null> | NodeHousekeepingReport | null;
}

/**
 * Full self-description for an enroll or heartbeat request.
 *
 * `selection` is the operator's capability opt-in; omitting it preserves the
 * original "advertise everything detected" behaviour.
 *
 * `telemetry` adds the two optional fields the Fleet runner indicator
 * renders (agent-CLI version, free disk). They are OMITTED from the
 * payload entirely when the probe returns null rather than sent as
 * `null`, because the server's heartbeat treats an absent field as
 * "leave the stored value alone" — so a probe that fails transiently
 * (a busy machine, a hung `--version`) does not wipe a good reading.
 */
export async function describeSelf(
	runner: CommandRunner,
	environment: CapabilityEnvironment,
	version: string,
	selection?: readonly string[] | null,
	telemetry: SelfDescriptionTelemetry = {}
): Promise<NodeSelfDescriptionPayload> {
	const detected = await detectCapabilities(runner, environment);
	const description: NodeSelfDescriptionPayload = {
		platform: describePlatform(environment),
		version: version.slice(0, MAX_VERSION_LENGTH),
		capabilities: applyCapabilitySelection(detected, selection)
	};

	const cliVersion = await resolveTelemetry(telemetry.cliVersion);
	if (typeof cliVersion === 'string' && cliVersion) {
		description.cliVersion = cliVersion;
	}
	const diskFreeBytes = await resolveTelemetry(telemetry.diskFreeBytes);
	if (typeof diskFreeBytes === 'number' && Number.isFinite(diskFreeBytes) && diskFreeBytes >= 0) {
		description.diskFreeBytes = diskFreeBytes;
	}
	const modelIdentity = await resolveTelemetry(telemetry.modelIdentity);
	if (typeof modelIdentity === 'string' && modelIdentity) {
		description.modelIdentity = modelIdentity;
	}
	// Fleet health signals (EW-776). Both halves land together or neither
	// does: a reason without a state has nothing to caption, and a state
	// the probe could not produce must stay ABSENT so the server keeps the
	// last one it was told.
	const workerHealth = await resolveTelemetry(telemetry.workerHealth);
	if (workerHealth && typeof workerHealth.workerState === 'string') {
		description.workerState = workerHealth.workerState;
		if (workerHealth.workerStateReason) {
			description.workerStateReason = workerHealth.workerStateReason;
		}
	}
	// Node housekeeping (EW-803). Copied field by field rather than
	// spread, for the reason the API controller's mapping carries the same
	// warning: this is a WIRE payload, and a spread would forward whatever
	// a future reporter happens to put on the object — straight into a
	// server whose validation pipe runs `forbidNonWhitelisted` and answers
	// an unexpected field with a 400. A 400 here is a failed beat, and a
	// node that cannot beat is swept offline.
	//
	// `minFreeDiskBytes` is the one field that IS forwarded as `null`: the
	// server reads absent as "leave alone", so an operator who switched
	// the floor off needs an explicit null to say so.
	const housekeeping = await resolveTelemetry(telemetry.housekeeping);
	if (housekeeping) {
		if (housekeeping.minFreeDiskBytes === null || typeof housekeeping.minFreeDiskBytes === 'number') {
			description.minFreeDiskBytes = housekeeping.minFreeDiskBytes;
		}
		if (typeof housekeeping.workspaceCount === 'number') {
			description.workspaceCount = housekeeping.workspaceCount;
		}
		if (typeof housekeeping.workspaceBytes === 'number') {
			description.workspaceBytes = housekeeping.workspaceBytes;
		}
		if (typeof housekeeping.lastReclaimAt === 'string' && housekeeping.lastReclaimAt) {
			description.lastReclaimAt = housekeeping.lastReclaimAt;
			if (typeof housekeeping.lastReclaimFreedBytes === 'number') {
				// Only ever alongside the instant it belongs to. A freed-bytes
				// figure with no time attached is unreadable: "4.1 GB freed"
				// is reassuring or alarming entirely depending on when.
				description.lastReclaimFreedBytes = housekeeping.lastReclaimFreedBytes;
			}
		}
	}
	return description;
}

/** Run one optional probe. A throwing probe is an absent field, never a failed beat. */
async function resolveTelemetry<T>(probe: (() => Promise<T | null> | T | null) | undefined): Promise<T | null> {
	if (!probe) return null;
	try {
		return await probe();
	} catch {
		return null;
	}
}

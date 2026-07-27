import { FLEET_BROWSER_CAPABILITY, FLEET_GPU_CAPABILITY } from '@ever-works/contracts';
import type { BrowserProbeIo } from './browser-probe';
import { detectGpu } from './gpu-probe';
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
 * Detect this machine's capability tags:
 * `os:<platform>`, `arch:<arch>`, `node:<major>`, the always-on
 * `terminal`/`workspace`, plus `docker`, `git`, `display`, `browser`,
 * `gpu` and `gpu:<vendor>` when present.
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
		hasTool(runner, 'git'),
		detectGpu(runner, environment.platform)
	]);
	const major = nodeMajor(environment.nodeVersion);
	const hasBrowser = typeof environment.browserPath === 'string' && environment.browserPath.length > 0;

	return normalizeCapabilities([
		`os:${environment.platform}`,
		`arch:${environment.arch}`,
		major === null ? null : `node:${major}`,
		...BASE_CAPABILITIES,
		docker ? 'docker' : null,
		git ? 'git' : null,
		environment.hasDisplay ? 'display' : null,
		hasBrowser ? FLEET_BROWSER_CAPABILITY : null,
		gpu ? FLEET_GPU_CAPABILITY : null,
		// Vendor is a second, narrower tag rather than a replacement:
		// a job that needs "any accelerator" must not have to enumerate
		// vendors, and one that needs CUDA must be able to say so.
		gpu ? `${FLEET_GPU_CAPABILITY}:${gpu.vendor}` : null
	]);
}

/** Full self-description for an enroll or heartbeat request. */
export async function describeSelf(
	runner: CommandRunner,
	environment: CapabilityEnvironment,
	version: string
): Promise<Required<NodeSelfDescription>> {
	return {
		platform: describePlatform(environment),
		version: version.slice(0, MAX_VERSION_LENGTH),
		capabilities: await detectCapabilities(runner, environment)
	};
}

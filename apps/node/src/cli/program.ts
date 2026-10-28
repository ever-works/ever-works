import { Command, CommanderError } from 'commander';
import { homedir as osHomedir, hostname as osHostname } from 'node:os';
import { stat as statFile, unlink as removeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { FleetVirtualSystemId } from '@ever-works/contracts';
import {
	parseCatalogueLock,
	resolveVirtualImage,
	VIRTUAL_CONTAINER_IMAGES
} from '../core/link/modules/virtual/catalogue';
import { resolveWindowsImage } from '../core/link/modules/virtual/windows';
import { createNativeScheduler } from '../core/link/modules/schedule/native-scheduler';
import { ScheduleHistory } from '../core/link/modules/schedule/schedule-history';
import { ScheduleLoop } from '../core/link/modules/schedule/schedule-loop';
import { ScheduleStore } from '../core/link/modules/schedule/schedule-store';
import { describeSelf, type CapabilityEnvironment } from '../core/capabilities';
import {
	helperAdmit,
	helperAdmitSigned,
	HelperAdmissionError,
	helperInstall,
	helperRevoke,
	helperStatus,
	type HelperAdmissionDeps
} from '../core/screen/helper/helper-admission';
import { helperControlAllow, helperControlDeny, helperControlStatus } from '../core/screen/helper/helper-control';
import { BAKED_HELPER_MANIFEST } from '../core/screen/helper/helper-manifest';
import { nodeHelperSignatureChecker } from '../core/screen/helper/helper-signature';
import { createHelperFs, helperPathsFor, type HelperFs } from '../core/screen/helper/helper-trust';
import { clearConfig, loadConfig, saveConfig, type ConfigFileSystem } from '../core/config-store';
import { resolveModelCliPaths, type ModelCliProbeResult } from '../core/model-cli-probe';
import { FleetClientError } from '../core/fleet-client';
import { untilHeartbeatAccepted } from '../core/heartbeat';
import {
	createNodeRuntime,
	enrollNode,
	installShutdownHandlers,
	pauseNode,
	unenrollNode,
	type NodeIo,
	type SignalSource
} from '../core/runtime';
import type { SecretStore } from '../core/secret-store';
import { formatBytes, type ResourceProbe } from '../core/resource-limits';
import { createConfigWorkerSafetyGate } from '../core/worker-safety-store';
import { measureWorkspaceFreeBytes } from '../core/workspaces/disk-headroom';
import { defaultFleetTaskWorkspaceRoot } from '../core/workspaces/fleet-task-workspace';
import { scanWorkspaceRoot, type WorkspaceInventory } from '../core/workspaces/workspace-inventory';
import {
	describeAge,
	planWorkspaceReap,
	policyFromConfig,
	runWorkspaceReap,
	startWorkspaceReaperTimer,
	type WorkspaceReapPlan,
	type WorkspaceReapResult
} from '../core/workspaces/workspace-reaper';
import {
	applyNodeLimitCeiling,
	clampResourceLimits,
	clampWorkspaceGcPolicy,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_WORKSPACE_GC_POLICY,
	DEFAULT_WORKSPACE_MAX_AGE_DAYS,
	effectiveMinFreeDiskBytes,
	MAX_CONCURRENT_JOBS,
	MAX_CPU_PERCENT,
	MAX_HEARTBEAT_INTERVAL_MS,
	MAX_MIN_FREE_DISK_BYTES,
	MAX_WORKSPACE_COUNT,
	MAX_WORKSPACE_MAX_AGE_DAYS,
	MIN_CONCURRENT_JOBS,
	MIN_CPU_PERCENT,
	MIN_HEARTBEAT_INTERVAL_MS,
	MIN_MEMORY_MB,
	MIN_MIN_FREE_DISK_BYTES,
	MIN_WORKSPACE_COUNT,
	MIN_WORKSPACE_MAX_AGE_DAYS,
	redactConfig,
	resolveNodeExecutionPolicy,
	type NodeConfig,
	type NodeExecutionPolicy,
	type NodeResourceLimits,
	type NodeWorkspaceGcPolicy
} from '../core/types';
import { API_URL_ENV, describeApiBase, readApiUrlPin, resolveApiBase } from '../core/api-base';
import {
	compareFleetNodeVersions,
	FLEET_NODE_UPGRADE_COMMAND,
	FLEET_USAGE_PRIVACY_SENTENCE,
	isFleetLinkEligible,
	isFleetNodeVersionBelowFloor
} from '@ever-works/contracts';
import { isModelCliCompatible, ModelCliCompatibilityProbe, type ModelCliCompatibility } from '../core/model-cli-compat';
import type { ModelCliPaths } from '../core/executors/model-cli';
import { readNodeLifecycleRecord, writeNodeLifecycleRecord, type NodeLifecycleRecord } from '../core/node-lifecycle';
import {
	describeConsents,
	describeLinkRecord,
	readNodeLinkRecord,
	writeNodeLinkRecord
} from '../core/link/link-record';
import { NODE_SOURCE_UPGRADE_HINT } from '../core/worker-loop';
import { DaemonControlClient } from '../core/sessions/daemon-client';
import { resolveSessionDaemonPaths } from '../core/sessions/daemon/daemon-paths';
import { installDaemonProcessHandlers, runSessionDaemon } from '../core/sessions/daemon/daemon-main';
import {
	SELF_UPDATE_EXIT_CODE,
	SelfUpdateController,
	readSelfUpdateRecord,
	writeSelfUpdateRecord
} from '../core/link/self-update';

/**
 * `ever-works-node` CLI.
 *
 * Verbs (PRD §3.3):
 *   enroll       consume a one-time token and persist the node credential
 *   start        run the heartbeat loop until SIGINT/SIGTERM
 *   pause        drain this node — stop taking new work, finish what is running
 *   resume       take work again
 *   unenroll     retire this node and erase the local credential
 *   status       show the local enrollment, credentials redacted
 *   capabilities print the tags this machine would report
 *   doctor       daemon version vs the platform floor, model-CLI compatibility,
 *                disk headroom vs the floor, and what the workspace reaper would do
 *   gc           run the workspace reaper (age / LRU, fail-closed; --dry-run to look)
 *
 * Built as `buildProgram(deps)` over injected IO so argument parsing and every
 * command body are unit-testable without a network, a disk or a real process.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
/** A command line that cannot be run as written (`enroll` with both or neither of --token / --token-file). */
export const EXIT_USAGE = 2;
/** Not enrolled / no usable config — distinct so scripts can branch on it. */
export const EXIT_NOT_ENROLLED = 3;

export class CliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = EXIT_FAILURE) {
		super(message);
		this.name = 'CliError';
		this.exitCode = exitCode;
	}
}

export interface CliDeps {
	io: NodeIo;
	fs: ConfigFileSystem;
	configPath: string;
	/** `process.platform`; drives the chmod (POSIX) vs ACL (win32) decision. */
	platform: string;
	/** User-facing output (stdout). Separate from the logger's diagnostic stream. */
	out(line: string): void;
	signals?: SignalSource;
	/**
	 * OS keychain, when this host has one. Absent means the credential
	 * falls back into the config file — announced loudly, never silently.
	 */
	secrets?: SecretStore | null;
	/**
	 * Blocks until the node should shut down. Defaults to "never resolves"
	 * (the real service runs until a signal arrives); tests override it.
	 */
	waitForShutdown?(): Promise<void>;
	/**
	 * Host sampler for the CPU/memory admission gate. Optional: without it
	 * only the concurrency ceiling is enforced.
	 */
	resourceProbe?: ResourceProbe;
	/**
	 * Executable-file probe for the `--claude-path` / `--codex-path` pins.
	 * Optional: a shell without it trusts the operator's path as given.
	 */
	fileExists?: (path: string) => boolean;
	/**
	 * Workspace housekeeping seam — the inventory scan and the reaper
	 * executor behind `doctor`, `gc` and the in-process timer. Defaults to
	 * the real filesystem-and-git implementations; tests inject fakes.
	 */
	workspaceHousekeeping?: {
		scan: typeof scanWorkspaceRoot;
		reap: typeof runWorkspaceReap;
	};
	/** Wall clock for ages and stamps; defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Sessions on computers (FL-04) — how to run this build's hidden
	 * `session-daemon` subcommand: the Node binary and this CLI's entry
	 * script. Set by the real executable only; absent (tests, embedders)
	 * means no session daemon is started and `sessions` is never advertised.
	 */
	sessionDaemonCommand?: { command: string; args: string[] };
	/** Owner-only ACL for a file on Windows (the session daemon's token). */
	restrictFile?: (file: string) => Promise<void> | void;
	/** Virtual computers (FL-16): the `enroll --token-file` reader (tests inject a fake). */
	enrollTokenFileIo?: EnrollTokenFileIo;
	/** The session daemon's own entry (the hidden subcommand); a seam for the CLI spec. */
	runSessionDaemon?: typeof runSessionDaemon;
	/**
	 * Fleet node link (FL-02 T-25) — the running binary's real path, so the
	 * opt-in self-update can tell an `npm install -g` install (which it
	 * upgrades) from anything else (which it refuses). Unset → refused.
	 */
	entryPath?: string | null;
	/**
	 * Desktop view & control (FL-07) — read one typed line from the person at
	 * this machine's keyboard (`helper admit` asks for the word `admit`). Set by
	 * the real executable only when stdin is a terminal; absent, `helper admit`
	 * refuses rather than approving without a person.
	 */
	readLine?: (prompt: string) => Promise<string | null>;
	/** Desktop view & control (FL-07) — `process.arch`, for the helper's build target. */
	arch?: string;
	/** Desktop view & control (FL-07) — the screen helper's filesystem (tests inject a fake). */
	helperFs?: HelperFs;
	/** Desktop view & control (FL-07) — the `helper install` download (tests inject a fake). */
	helperFetch?: typeof fetch;
}

/**
 * Parse and validate a `--heartbeat-interval` value in SECONDS.
 * Rejects non-numeric and out-of-range input up front rather than silently
 * clamping, so a typo does not quietly become a 60s default.
 */
export function parseIntervalSeconds(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
		throw new CliError(`--heartbeat-interval must be a whole number of seconds (got "${raw}")`);
	}
	const ms = seconds * 1000;
	if (ms < MIN_HEARTBEAT_INTERVAL_MS || ms > MAX_HEARTBEAT_INTERVAL_MS) {
		throw new CliError(
			`--heartbeat-interval must be between ${MIN_HEARTBEAT_INTERVAL_MS / 1000} and ${
				MAX_HEARTBEAT_INTERVAL_MS / 1000
			} seconds (got ${seconds})`
		);
	}
	return ms;
}

function loadOptions(deps: CliDeps): { secrets?: SecretStore | null; logger: typeof deps.io.logger } {
	return { secrets: deps.secrets ?? null, logger: deps.io.logger };
}

async function requireConfig(deps: CliDeps): Promise<NodeConfig> {
	const config = await loadConfig(deps.fs, deps.configPath, loadOptions(deps));
	if (!config) {
		throw new CliError(
			`This machine is not enrolled (no usable config at ${deps.configPath}).\n` +
				'Issue an enrollment token on the platform Fleet settings page, then run:\n' +
				'  ever-works-node enroll --api-url <url> --token <token>',
			EXIT_NOT_ENROLLED
		);
	}
	return config;
}

// ---------------------------------------------------------------------------
// Command bodies
// ---------------------------------------------------------------------------

export interface EnrollCommandOptions {
	apiUrl: string;
	/** The one-time token on the command line — or, instead, {@link tokenFile}. */
	token?: string;
	/**
	 * Virtual computers (FL-16, CONTRACTS R-35, spec FR-14) — read the one-time
	 * token from this file instead of the command line (where any user of the
	 * machine can read it in the process list). The file is read once, trimmed
	 * and DELETED; on POSIX it must belong to this user and be readable by no
	 * one else (0600 or tighter). Exactly one of --token / --token-file.
	 */
	tokenFile?: string;
	name?: string;
	heartbeatInterval?: string;
	/** Comma-separated capability opt-in (A15). Omitted = offer everything detected. */
	capabilities?: string;
	/** Resource ceilings (A16). */
	concurrency?: string;
	maxCpu?: string;
	maxMemory?: string;
	/** Disk floor in MEBIbytes (`--min-free-disk`); `--no-disk-floor` sets `diskFloor: false`. */
	minFreeDisk?: string;
	diskFloor?: boolean;
	/** Workspace reaper policy (`--workspace-max-age <days>`, `--workspace-max-count <n>`). */
	workspaceMaxAge?: string;
	workspaceMaxCount?: string;
}

/** Parse `--capabilities a,b,c` into a tag list; blank entries are dropped. */
export function parseCapabilityList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) {
		return undefined;
	}
	return raw
		.split(',')
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}

/** Parse one bounded numeric flag, refusing (never silently clamping) bad input. */
function parseBounded(raw: string | undefined, flag: string, min: number, max: number): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new CliError(`${flag} must be a whole number (got "${raw}")`);
	}
	if (value < min || value > max) {
		throw new CliError(`${flag} must be between ${min} and ${max} (got ${value})`);
	}
	return value;
}

const MIB = 1024 ** 2;

/** Build the resource-limit overrides implied by the CLI flags, if any. */
export function parseLimitFlags(options: {
	concurrency?: string;
	maxCpu?: string;
	maxMemory?: string;
	minFreeDisk?: string;
	diskFloor?: boolean;
}): Partial<NodeResourceLimits> | undefined {
	const maxConcurrentJobs = parseBounded(
		options.concurrency,
		'--concurrency',
		MIN_CONCURRENT_JOBS,
		MAX_CONCURRENT_JOBS
	);
	const maxCpuPercent = parseBounded(options.maxCpu, '--max-cpu', MIN_CPU_PERCENT, MAX_CPU_PERCENT);
	const maxMemoryMb = parseBounded(options.maxMemory, '--max-memory', MIN_MEMORY_MB, Number.MAX_SAFE_INTEGER);
	const minFreeDiskMb = parseBounded(
		options.minFreeDisk,
		'--min-free-disk',
		MIN_MIN_FREE_DISK_BYTES / MIB,
		MAX_MIN_FREE_DISK_BYTES / MIB
	);
	if (minFreeDiskMb !== undefined && options.diskFloor === false) {
		throw new CliError('--min-free-disk and --no-disk-floor contradict each other');
	}

	const limits: Partial<NodeResourceLimits> = {};
	if (maxConcurrentJobs !== undefined) limits.maxConcurrentJobs = maxConcurrentJobs;
	if (maxCpuPercent !== undefined) limits.maxCpuPercent = maxCpuPercent;
	if (maxMemoryMb !== undefined) limits.maxMemoryMb = maxMemoryMb;
	if (minFreeDiskMb !== undefined) limits.minFreeDiskBytes = minFreeDiskMb * MIB;
	// `--no-disk-floor` is the only way to switch the floor OFF: an explicit
	// null, distinct from "not mentioned" (which keeps the default floor).
	if (options.diskFloor === false) limits.minFreeDiskBytes = null;
	return Object.keys(limits).length > 0 ? limits : undefined;
}

/** Build the workspace-reaper policy overrides implied by the CLI flags, if any. */
export function parseWorkspaceGcFlags(options: {
	workspaceMaxAge?: string;
	workspaceMaxCount?: string;
}): Partial<NodeWorkspaceGcPolicy> | undefined {
	const maxAgeDays = parseBounded(
		options.workspaceMaxAge,
		'--workspace-max-age',
		MIN_WORKSPACE_MAX_AGE_DAYS,
		MAX_WORKSPACE_MAX_AGE_DAYS
	);
	const maxCount = parseBounded(
		options.workspaceMaxCount,
		'--workspace-max-count',
		MIN_WORKSPACE_COUNT,
		MAX_WORKSPACE_COUNT
	);
	const policy: Partial<NodeWorkspaceGcPolicy> = {};
	if (maxAgeDays !== undefined) policy.maxAgeDays = maxAgeDays;
	if (maxCount !== undefined) policy.maxCount = maxCount;
	return Object.keys(policy).length > 0 ? policy : undefined;
}

function describeLimits(limits: NodeResourceLimits): string {
	const parts = [`${limits.maxConcurrentJobs} concurrent job(s)`];
	parts.push(limits.maxCpuPercent === null ? 'no CPU ceiling' : `CPU < ${limits.maxCpuPercent}%`);
	parts.push(limits.maxMemoryMb === null ? 'no memory ceiling' : `memory < ${limits.maxMemoryMb}MB`);
	const floor = effectiveMinFreeDiskBytes(limits);
	parts.push(floor === null ? 'no disk floor' : `disk floor ${formatBytes(floor)}`);
	return parts.join(', ');
}

function describeWorkspaceGc(policy: NodeWorkspaceGcPolicy): string {
	return `max age ${policy.maxAgeDays} d, ${policy.maxCount === null ? 'no count budget' : `at most ${policy.maxCount}`}`;
}

/** What `--token-file` reads through (injected so the checks are testable without a disk). */
export interface EnrollTokenFileIo {
	/** `{ uid, mode }` of the file, or null when it does not exist. */
	stat(path: string): Promise<{ uid: number; mode: number } | null>;
	readFile(path: string): Promise<string | null>;
	remove(path: string): Promise<void>;
	/** The current user's uid (POSIX), or null where it does not apply. */
	currentUid(): number | null;
}

function defaultEnrollTokenFileIo(deps: CliDeps): EnrollTokenFileIo {
	return {
		stat: async (path) => {
			try {
				const info = await statFile(path);
				return { uid: info.uid, mode: info.mode };
			} catch {
				return null;
			}
		},
		readFile: (path) => deps.fs.readFile(path),
		remove: async (path) => {
			if (deps.fs.remove) await deps.fs.remove(path);
			else await removeFile(path).catch(() => undefined);
		},
		currentUid: () => (typeof process.getuid === 'function' ? process.getuid() : null)
	};
}

/**
 * The one-time token of `enroll` (CONTRACTS R-35): `--token`, or the contents
 * of `--token-file` (read once, trimmed, then deleted — whether or not it
 * held a usable token, so a token file never outlives the attempt). Both or
 * neither is a usage error (exit 2). On POSIX a token file that another user
 * owns, or that group / others may read, is refused before it is read.
 */
export async function resolveEnrollToken(
	deps: CliDeps,
	options: Pick<EnrollCommandOptions, 'token' | 'tokenFile'>,
	io: EnrollTokenFileIo = deps.enrollTokenFileIo ?? defaultEnrollTokenFileIo(deps)
): Promise<string> {
	const hasToken = typeof options.token === 'string' && options.token.length > 0;
	const hasFile = typeof options.tokenFile === 'string' && options.tokenFile.length > 0;
	if (hasToken === hasFile) {
		throw new CliError('enroll needs exactly one of --token <token> or --token-file <file>', EXIT_USAGE);
	}
	if (hasToken) return options.token as string;
	const path = options.tokenFile as string;
	const info = await io.stat(path);
	if (!info) throw new CliError(`The token file ${path} does not exist`);
	try {
		if (deps.platform !== 'win32') {
			const uid = io.currentUid();
			if (uid !== null && info.uid !== uid) {
				throw new CliError(`The token file ${path} belongs to another user; refusing to read it`);
			}
			if ((info.mode & 0o077) !== 0) {
				throw new CliError(
					`The token file ${path} is readable by other users (it must be 0600); refusing to read it`
				);
			}
		}
		const raw = await io.readFile(path);
		const token = (raw ?? '').trim();
		if (!token) throw new CliError(`The token file ${path} is empty`);
		return token;
	} finally {
		// The file is spent either way: never leave a token behind.
		await io.remove(path).catch(() => undefined);
	}
}

export async function runEnroll(deps: CliDeps, options: EnrollCommandOptions): Promise<void> {
	const token = await resolveEnrollToken(deps, options);
	const heartbeatIntervalMs = parseIntervalSeconds(options.heartbeatInterval);
	const capabilitySelection = parseCapabilityList(options.capabilities);
	const limits = parseLimitFlags(options);
	const workspaceGc = parseWorkspaceGcFlags(options);
	const config = await enrollNode({
		...deps.io,
		apiUrl: options.apiUrl,
		token,
		kind: 'node',
		...(options.name !== undefined ? { name: options.name } : {}),
		...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
		...(capabilitySelection !== undefined ? { capabilitySelection } : {}),
		...(limits !== undefined ? { limits } : {})
	});
	if (workspaceGc !== undefined) {
		config.workspaceGc = clampWorkspaceGcPolicy({ ...DEFAULT_WORKSPACE_GC_POLICY, ...workspaceGc });
	}

	await saveConfig(deps.fs, deps.configPath, config, {
		platform: deps.platform,
		secrets: deps.secrets ?? null,
		logger: deps.io.logger
	});

	deps.out(`Enrolled as node ${config.nodeId}`);
	deps.out(`  name         ${config.name ?? '(assigned by the platform)'}`);
	deps.out(`  api          ${config.apiUrl}`);
	deps.out(`  capabilities ${config.capabilities.join(', ') || '(none detected)'}`);
	deps.out(`  limits       ${describeLimits(clampResourceLimits(config.limits))}`);
	deps.out(`  workspace gc ${describeWorkspaceGc(config.workspaceGc ?? DEFAULT_WORKSPACE_GC_POLICY)}`);
	deps.out(`  config       ${deps.configPath}`);
	deps.out(`  credential   ${deps.secrets ? deps.secrets.label : 'config file (no OS keychain available)'}`);
	deps.out('');
	deps.out('Run `ever-works-node start` to begin heartbeating.');
}

export interface StartCommandOptions {
	heartbeatInterval?: string;
	/** Opt in to leasing and executing platform work on this machine. */
	work?: boolean;
	concurrency?: string;
	maxCpu?: string;
	maxMemory?: string;
	/** Disk floor override for this process (MB); `--no-disk-floor` switches it off. */
	minFreeDisk?: string;
	diskFloor?: boolean;
	/**
	 * Workspace reaper policy. Unlike the ceilings above these are PERSISTED
	 * when given on `start` (the brief asks for it, and `install-service.ps1`
	 * re-applies `start` flags on every re-install — a policy that only lived
	 * for one process would silently revert on the next reboot).
	 */
	workspaceMaxAge?: string;
	workspaceMaxCount?: string;
	/** Agent execution v2 — pin the Claude Code executable for this process. */
	claudePath?: string;
	/** Agent execution v2 — pin the Codex executable for this process. */
	codexPath?: string;
	/**
	 * Persistent worktree root for repository-backed agent Tasks (absolute).
	 * Default: `EVER_WORKS_NODE_WORKSPACE_ROOT`, then `~/.ever-works/fleet-workspaces`.
	 */
	workspaceRoot?: string;
	/**
	 * Agent computers — allow live viewing of this machine from the
	 * dashboard. Independent of `--work`: a machine can be watchable without
	 * taking platform work, and vice versa.
	 */
	attend?: boolean;
	/**
	 * Fleet node link (FL-02) — allow managing this machine from the
	 * dashboard: owner sessions, logs, services, Docker, processes, ports,
	 * files, commands, schedules, checkout discovery, wake. A fourth consent,
	 * independent of `--work` and `--attend`.
	 */
	manage?: boolean;
	/**
	 * Usage & cost on the fleet (FL-20, CONTRACTS §1.1) — the periodic
	 * transcript scan: token counts, models and session ids from this
	 * machine's Claude Code and Codex records, never prompts, output or file
	 * contents. A consent of its own, process-scoped like `--manage`; off by
	 * default.
	 */
	usageScan?: boolean;
	/**
	 * Fleet node link (FL-02 T-25) — let this machine upgrade itself when the
	 * platform raises its version floor or names a recommended version: it
	 * waits for running jobs, installs through npm, and exits 75 so its
	 * service manager starts the new binary. Off by default (report only).
	 */
	autoUpdate?: boolean;
	/**
	 * Schedules on computers (FL-13 P3) — also hand this machine's schedules to
	 * the operating system's scheduler when the node is not a service, so they
	 * run while nobody has the node open. Off by default; process-scoped.
	 */
	nativeSchedules?: boolean;
	/**
	 * Checkouts on computers (FL-14, CONTRACTS R-41) — a folder this machine's
	 * owner keeps code in; discovery walks it for git clones. Repeatable;
	 * persisted (the list given replaces the stored one), like
	 * `--workspace-root`.
	 */
	codeFolder?: string[];
	/**
	 * Logs on computers (FL-08, CONTRACTS R-18) — a folder this machine shares
	 * with the dashboard (repeatable): the Logs tab lists the log files under
	 * it, beside the standard log directories and the workspace root. Absolute;
	 * never a filesystem root (the home directory as a whole is refused by the
	 * resolver). Process-scoped, like `--manage`.
	 */
	filesRoot?: string[];
}

/** Parse every `--files-root` (FL-08): absolute, not a filesystem root, de-duplicated. */
export function parseFilesRoots(raw: readonly string[] | undefined, platform: string): string[] {
	const out: string[] = [];
	for (const entry of raw ?? []) {
		const value = entry.trim();
		if (value.length === 0) throw new CliError('--files-root must not be empty');
		const path = platform === 'win32' ? win32 : posix;
		if (!path.isAbsolute(value) || (platform === 'win32' && !WIN32_DRIVE_OR_UNC_ROOTED.test(value))) {
			throw new CliError(`--files-root must be an absolute directory (got "${entry}")`);
		}
		const normalized = path.resolve(value);
		if (normalized === path.parse(normalized).root) {
			throw new CliError(`--files-root cannot be a filesystem root (got "${entry}")`);
		}
		if (!out.includes(normalized)) out.push(normalized);
	}
	return out;
}

/**
 * Parse `--code-folder` (FL-14, spec FR-3): every value absolute (a leading
 * `~/` is the home folder), never a filesystem root, and never the home
 * folder ITSELF — discovery must not walk a whole home directory. Duplicates
 * collapse. `undefined` / empty means the flag was not given.
 */
export function parseCodeFolders(
	raw: readonly string[] | undefined,
	platform: string,
	home: string = osHomedir()
): string[] | undefined {
	if (!raw || raw.length === 0) return undefined;
	const path = platform === 'win32' ? win32 : posix;
	const homeResolved = home ? path.resolve(home) : '';
	const out: string[] = [];
	for (const entry of raw) {
		let value = entry.trim();
		if (value.length === 0) throw new CliError('--code-folder must not be empty');
		if (value === '~') {
			throw new CliError('--code-folder cannot be your whole home folder; name the folder you keep code in');
		}
		if ((value.startsWith('~/') || value.startsWith('~\\')) && homeResolved) {
			value = path.join(homeResolved, value.slice(2));
		}
		if (!path.isAbsolute(value) || (platform === 'win32' && !WIN32_DRIVE_OR_UNC_ROOTED.test(value))) {
			throw new CliError(`--code-folder must be an absolute directory (got "${entry}")`);
		}
		const normalized = path.resolve(value);
		if (normalized === path.parse(normalized).root) {
			throw new CliError(`--code-folder cannot be a filesystem root (got "${entry}")`);
		}
		const same =
			platform === 'win32'
				? normalized.toLowerCase() === homeResolved.toLowerCase()
				: normalized === homeResolved;
		if (homeResolved && same) {
			throw new CliError('--code-folder cannot be your whole home folder; name the folder you keep code in');
		}
		if (!out.includes(normalized)) out.push(normalized);
	}
	if (out.length > 32) throw new CliError('--code-folder can be given at most 32 times');
	return out;
}

/**
 * Parse `--workspace-root`: the directory the node keeps its bare-repository
 * cache and per-Task worktrees under.
 *
 * It must be ABSOLUTE. The node runs as a service whose working directory
 * is whatever the service manager happened to set (`%ProgramData%`,
 * `/`, the unit's `WorkingDirectory`), so a relative root would land
 * every checkout somewhere the operator did not choose — and a
 * filesystem root is refused for the same reason the provisioner refuses
 * it: the node deletes stale worktrees under this directory.
 *
 * Absoluteness is judged by the HOST platform (injected, so the rule is
 * testable for both shapes): `C:\fleet` is absolute on Windows and not
 * on POSIX, and `/srv/fleet` is absolute on both.
 *
 * On Windows "absolute" additionally means DRIVE- or UNC-ROOTED. Node's
 * `path.win32.isAbsolute` accepts a rooted-but-driveless `\fleet` (and
 * `/fleet`, `\\fleet`, `\\nas\`), all of which `path.win32.resolve` then
 * completes with the drive of the CURRENT directory — exactly the
 * service-manager-chosen location this flag exists to avoid. So a Windows
 * root must start with `<drive>:\` (or `/`), or be a UNC path naming both
 * a server and a share. `install-service.ps1` applies the same rule.
 */
const WIN32_DRIVE_OR_UNC_ROOTED = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/;

export function parseWorkspaceRoot(raw: string | undefined, platform: string): string | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const value = raw.trim();
	if (value.length === 0) {
		throw new CliError('--workspace-root must not be empty');
	}
	const path = platform === 'win32' ? win32 : posix;
	if (!path.isAbsolute(value) || (platform === 'win32' && !WIN32_DRIVE_OR_UNC_ROOTED.test(value))) {
		throw new CliError(`--workspace-root must be an absolute directory (got "${raw}")`);
	}
	const normalized = path.resolve(value);
	if (normalized === path.parse(normalized).root) {
		throw new CliError(`--workspace-root cannot be a filesystem root (got "${raw}")`);
	}
	return normalized;
}

export async function runStart(deps: CliDeps, options: StartCommandOptions): Promise<void> {
	const override = parseIntervalSeconds(options.heartbeatInterval);
	// Usage errors first, before the config is even read.
	const workspaceRoot = parseWorkspaceRoot(options.workspaceRoot, deps.platform);
	const codeFolders = parseCodeFolders(options.codeFolder, deps.platform);
	const filesRoots = parseFilesRoots(options.filesRoot, deps.platform);
	const workspaceGcOverrides = parseWorkspaceGcFlags(options);
	const stored = await requireConfig(deps);
	// The reaper policy is persisted on `start` (see `StartCommandOptions`),
	// onto the STORED config — the heartbeat-interval override above is
	// process-only and must not be written along with it.
	const workspaceGc = clampWorkspaceGcPolicy({
		...(stored.workspaceGc ?? DEFAULT_WORKSPACE_GC_POLICY),
		...(workspaceGcOverrides ?? {})
	});
	// `--workspace-root` is persisted for the same reason (EW-803, review
	// AO-6): `doctor` and `gc` have no other way to learn which tree the
	// SERVICE runs against, and both disk-refusal messages send the
	// operator to those two commands. The Windows installer's preflight
	// errors unless `-WorkspaceRoot` is passed, so on the shipped layout
	// the un-persisted root was routinely the wrong one — an empty
	// directory in the admin's own profile, reported as "nothing to
	// reclaim" while the node refused every job for want of space on D:.
	const rootChanged = workspaceRoot !== undefined && workspaceRoot !== stored.workspaceRoot;
	// `--code-folder` is persisted for the same reason (FL-14): the service
	// re-reads it on every start, and `install-service` re-applies flags.
	const foldersChanged =
		codeFolders !== undefined && JSON.stringify(codeFolders) !== JSON.stringify(stored.codeFolders ?? []);
	if (workspaceGcOverrides !== undefined || rootChanged || foldersChanged) {
		await saveConfig(
			deps.fs,
			deps.configPath,
			{
				...stored,
				workspaceGc,
				...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
				...(codeFolders !== undefined ? { codeFolders } : {})
			},
			{ platform: deps.platform, secrets: deps.secrets ?? null, logger: deps.io.logger }
		);
	}
	const config: NodeConfig = {
		...stored,
		workspaceGc,
		...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
		...(codeFolders !== undefined ? { codeFolders } : {}),
		...(override === undefined ? {} : { heartbeatIntervalMs: override })
	};

	const workerEnabled = options.work === true;
	const attendEnabled = options.attend === true;
	const manageEnabled = options.manage === true;
	const usageScanEnabled = options.usageScan === true;
	// Fleet node link (FL-02 T-25): the opt-in self-update. Built after the
	// runtime (it needs the lanes to know when the machine is idle), reached
	// through these closures from the heartbeat.
	const autoUpdate = options.autoUpdate === true;
	let selfUpdate: SelfUpdateController | null = null;
	let restartForUpdate: string | null = null;
	// A node paused by `ever-works-node pause` comes back paused: the
	// operator drained the machine on purpose, and a service restart
	// (or a reboot) must not quietly hand it work again.
	const startPaused = config.paused === true;
	// `--concurrency` is the legacy single knob; `limits` supersedes it,
	// so it is folded in as the concurrency ceiling rather than passed
	// alongside — two sources for one number is how they drift.
	const concurrency = parseConcurrency(options.concurrency);
	const limitOverrides = parseLimitFlags(options);
	const effectiveLimits = clampResourceLimits({
		...(concurrency !== undefined ? { maxConcurrentJobs: concurrency } : {}),
		...(config.limits ?? {}),
		...(limitOverrides ?? {})
	});
	// Agent execution v2 — which model CLIs this process may spawn. The
	// flags re-run the probe with the operator's pins; a pin that does not
	// resolve DISABLES that CLI rather than falling back to PATH.
	const modelCli =
		options.claudePath || options.codexPath
			? keepStartupTimeouts(
					resolveModelCliPaths(
						{
							env: {},
							platform: deps.platform,
							fileExists: deps.fileExists ?? (() => true),
							lookupAllOnPath: () => []
						},
						{
							'claude-code': options.claudePath ?? deps.io.environment.modelCli?.['claude-code'] ?? null,
							codex: options.codexPath ?? deps.io.environment.modelCli?.codex ?? null
						}
					),
					deps.io.environment,
					{ 'claude-code': Boolean(options.claudePath), codex: Boolean(options.codexPath) }
				)
			: {
					paths: deps.io.environment.modelCli ?? {},
					notes: deps.io.environment.modelCliNotes ?? [],
					timedOut: deps.io.environment.modelCliTimedOut ?? []
				};
	if (workerEnabled) {
		for (const note of modelCli.notes) {
			deps.io.logger.info(`Model CLI — ${note}`);
		}
	}
	// The SAME resolution feeds both the executor and the capability tags:
	// a pin that adds a CLI advertises it, a pin that disables one withdraws
	// it — otherwise the node could run jobs it does not advertise, or be
	// offered jobs it cannot run.
	const io: NodeIo = {
		...deps.io,
		environment: {
			...deps.io.environment,
			modelCli: modelCli.paths,
			modelCliNotes: modelCli.notes,
			modelCliTimedOut: [...modelCli.timedOut]
		}
	};
	/** Stops the management lane when the worker host quarantines (set once the lanes exist). */
	let haltManagementLane: (() => void) | null = null;
	const runtime = createNodeRuntime(config, io, {
		workerEnabled,
		startPaused,
		limits: effectiveLimits,
		modelCli: modelCli.paths,
		// Written directly (not via a conditional spread) so excess-property
		// checking keeps this name tied to the runtime option it feeds.
		agentTaskWorkspaceRoot: workspaceRoot,
		// Re-read before writing: the file may have changed since this service
		// started (`ever-works-node policy` run meanwhile), and a quarantine must
		// record `unsafe` without reverting anything else in it.
		persistUnsafe: async (unsafe) => {
			// The quarantine disables ALL leasing on this machine: the management lane runs
			// machine-level jobs (runners, virtual computers, usage scans) and stops with it.
			haltManagementLane?.();
			const current =
				(await loadConfig(deps.fs, deps.configPath, {
					secrets: deps.secrets ?? null,
					logger: deps.io.logger
				}).catch(() => null)) ?? config;
			await saveConfig(
				deps.fs,
				deps.configPath,
				{ ...current, unsafe },
				{
					platform: deps.platform,
					secrets: deps.secrets ?? null,
					logger: deps.io.logger
				}
			);
		},
		workerSafetyGate: createConfigWorkerSafetyGate(deps.fs, deps.configPath, { platform: deps.platform }),
		// Node lifecycle (slice AR): what the platform last said about this
		// daemon's version, recorded beside the config for `status`/`doctor`.
		persistLifecycle: (record) => writeNodeLifecycleRecord(deps.fs, deps.configPath, record),
		...(deps.resourceProbe ? { resourceProbe: deps.resourceProbe } : {}),
		attendEnabled,
		// Fleet node link (FL-02): the fourth consent, and the link itself. The
		// link opens on the first accepted heartbeat when any of --work,
		// --attend, --manage is on; its state is recorded for `status`.
		manageEnabled,
		// Usage & cost on the fleet (FL-20): the transcript scan's consent and its
		// state folder beside the config (offsets, buckets, counted record ids).
		usageScanEnabled,
		usageStateDir: (deps.platform === 'win32' ? win32 : posix).join(
			(deps.platform === 'win32' ? win32 : posix).dirname(deps.configPath),
			'usage'
		),
		// Logs on computers (FL-08): the folders this machine shares (R-18).
		...(filesRoots.length > 0 ? { filesRoots } : {}),
		nodeLink: true,
		persistLinkState: (record) => writeNodeLinkRecord(deps.fs, deps.configPath, record),
		// Sessions on computers (FL-04): the session daemon, for a process that
		// may host sessions (`--manage` or `--work`). It is spawned detached and
		// outlives this process, so a restart or an upgrade ends no session.
		...(deps.sessionDaemonCommand
			? {
					sessionDaemon: {
						...deps.sessionDaemonCommand,
						paths: resolveSessionDaemonPaths({
							configPath: deps.configPath,
							platform: deps.platform,
							env: process.env
						})
					}
				}
			: {}),
		...(deps.restrictFile ? { restrictFile: deps.restrictFile } : {}),
		// Desktop view & control (FL-07): the screen helper's files, beside the config
		// (used only under --attend).
		screenHelperPaths: helperPathsFor(deps.configPath, deps.platform),
		// Commands on computers (FL-12): the last 30 runs' full output, beside the config.
		commandOutputDir: (deps.platform === 'win32' ? win32 : posix).join(
			(deps.platform === 'win32' ? win32 : posix).dirname(deps.configPath),
			'commands'
		),
		// Schedules on computers (FL-13): the machine's own schedules, their runs and outputs, beside the config.
		scheduleDir: (deps.platform === 'win32' ? win32 : posix).join(
			(deps.platform === 'win32' ? win32 : posix).dirname(deps.configPath),
			'schedules'
		),
		// Fleet node link (FL-02 T-25): the self-update's report rides every
		// beat, and every accepted beat's version verdict reaches it.
		selfUpdateReport: () => selfUpdate?.report() ?? null,
		// Schedules on computers (FL-13 P3): the OS-scheduler fallback, opt-in.
		...(options.nativeSchedules === true && deps.sessionDaemonCommand
			? {
					nativeSchedules: true,
					nativeScheduleCommand: {
						file: deps.sessionDaemonCommand.command,
						args: [...deps.sessionDaemonCommand.args]
					}
				}
			: {}),
		onHeartbeatAccepted: (response) => selfUpdate?.onHeartbeat(response),
		// Checkouts on computers (FL-14): the node-local checkout registry,
		// beside the config like the session daemon's state.
		checkoutsRegistryPath: (deps.platform === 'win32' ? win32 : posix).join(
			(deps.platform === 'win32' ? win32 : posix).dirname(deps.configPath),
			'checkouts.json'
		),
		// Actions runners on computers (FL-18): the runners this machine hosts keep
		// their folders (GitHub's runner build, its config, its logs) beside the config.
		runnersDataDir: (deps.platform === 'win32' ? win32 : posix).join(
			(deps.platform === 'win32' ? win32 : posix).dirname(deps.configPath),
			'actions-runners'
		),
		// Virtual computers (FL-16): the children this host builds keep their
		// folders (bootstrap, meta, the catalogue lock) beside the config. A
		// Windows host never hosts virtual computers (spec U4).
		...(deps.platform !== 'win32'
			? {
					virtualDataDir: posix.join(posix.dirname(deps.configPath), 'virtual'),
					// Windows VM passwords (FL-16 P2) live in the same keychain as the node credential.
					virtualSecrets: deps.secrets ?? null
				}
			: {})
	});
	// The daemon starts with the node, before the first beat, so that beat can
	// already report it (and advertise `sessions`).
	runtime.sessions?.supervisor.start();
	// Session status (FL-05): the hook endpoint, its file and client — before the
	// first session starts, so its hooks have somewhere to go.
	void runtime.sessions?.status?.start();
	if (workerEnabled) {
		// Node lifecycle (slice AR): say at startup what each pinned CLI is
		// and whether this node can drive it — the first place an operator
		// looks after a CLI auto-updated overnight. Not awaited: a hung
		// `--help` must never delay the first heartbeat.
		void logModelCliCompatibility(deps, runtime.cliCompat, modelCli.paths);
	}
	const { loop, worker } = runtime;
	const attendedWorker = runtime.attended?.worker ?? null;
	// Fleet node link (FL-02, CONTRACTS R-34): the management lane, present only
	// when a kind registered for it has its consent on (none in FL-02).
	const managementWorker = runtime.management?.worker ?? null;
	haltManagementLane = managementWorker
		? () => {
				void managementWorker.stop();
			}
		: null;
	selfUpdate = new SelfUpdateController({
		enabled: autoUpdate,
		currentVersion: deps.io.version,
		runner: deps.io.runner,
		logger: deps.io.logger,
		platform: deps.platform,
		entryPath: deps.entryPath ?? null,
		// Never kills work: an upgrade waits until no lane runs a job.
		isIdle: () =>
			[worker, attendedWorker, managementWorker].every(
				(lane) => !lane || lane.getState().activeJobIds.length === 0
			),
		requestRestart: (to) => {
			restartForUpdate = to;
			requestShutdown();
		},
		persist: (record) => writeSelfUpdateRecord(deps.fs, deps.configPath, record),
		previous: await readSelfUpdateRecord(deps.fs, deps.configPath),
		...(deps.now ? { now: deps.now } : {})
	});
	// One line per ACCEPTED beat. The loop patches its state more than once per
	// beat (`connected`, then the next attempt's delay) and every patch
	// notifies, so keying on the state alone logged each beat twice. Keyed on
	// the beat itself: each accepted beat stores a freshly parsed `node` and
	// its own timestamp, and a later patch of the same beat changes neither.
	// Not on the transition into `connected`: a tick that starts connected
	// never passes through `connecting`, so that would drop this per-beat
	// liveness line.
	let lastLoggedBeat: { node: unknown; at: number | null } | null = null;
	loop.onChange((state) => {
		if (state.state !== 'connected') return;
		if (lastLoggedBeat && lastLoggedBeat.node === state.node && lastLoggedBeat.at === state.lastHeartbeatAt) return;
		lastLoggedBeat = { node: state.node, at: state.lastHeartbeatAt };
		deps.io.logger.info(`Heartbeat accepted — node ${config.nodeId} is online`);
	});

	deps.out(`Starting node ${config.nodeId} → ${config.apiUrl} (every ${config.heartbeatIntervalMs / 1000}s)`);
	// Registered BEFORE the first beat so a Ctrl-C during startup is still a
	// graceful shutdown rather than an abrupt kill.
	let requestShutdown: () => void = () => undefined;
	const signalled = new Promise<void>((resolve) => {
		requestShutdown = resolve;
	});
	if (deps.signals) {
		installShutdownHandlers(deps.signals, () => {
			deps.io.logger.info(
				worker
					? 'Shutdown signal received — stopping heartbeat and draining in-flight jobs'
					: 'Shutdown signal received — stopping heartbeat'
			);
			requestShutdown();
		});
	}

	await loop.start();
	// The lanes lease only after a heartbeat has been ACCEPTED (#2628): its
	// answer carries the owner's limit ceiling and the version verdict, and
	// the lease API uses this node's `max` as sent. `loop.start()` resolves
	// after the first ATTEMPT, accepted or not. When the first beat was
	// accepted (the usual case) this is exactly the old sequence. When it was
	// not, the lanes start in the background on the first accepted beat, and
	// a shutdown before that ends the wait without starting them.
	let shuttingDown = false;
	const startLanes = async (): Promise<void> => {
		if (worker) {
			await worker.start();
		}
		if (attendedWorker) {
			await attendedWorker.start();
			deps.out(
				runtime.attended?.captureBackend
					? 'Live view enabled — the owner can watch this machine from the dashboard (screen and terminal)'
					: 'Live view enabled — terminal only: no browser was found here to show a screen'
			);
		}
		if (managementWorker && worker?.getState().state === 'unsafe') {
			deps.out(
				'Management lane held — the worker host is QUARANTINED, which disables every lease on this machine. Clear it first: `ever-works-node clear-quarantine --confirm-process-tree-stopped`.'
			);
		} else if (managementWorker) {
			await managementWorker.start();
			deps.out(
				`Management lane enabled — leasing [${(runtime.management?.kinds ?? []).join(', ')}] one at a time, outside --concurrency`
			);
		}
	};
	let lanesStarted: Promise<void> = Promise.resolve();
	let laneStartFailed = false;
	let laneStartFailure: unknown = undefined;
	if (worker || attendedWorker || managementWorker) {
		if (loop.getState().state === 'connected') {
			await startLanes();
		} else {
			deps.out(
				'Waiting for the platform to accept a heartbeat before leasing work (its answer carries this node’s limits and version verdict)'
			);
			lanesStarted = startLanesAfterAcceptedHeartbeat(
				loop,
				async () => {
					deps.io.logger.info('Heartbeat accepted — starting the worker lanes');
					await startLanes();
				},
				() => !shuttingDown
			).then((outcome) => {
				if (!outcome.failed) return;
				// A lane that cannot start leaves a node that beats but never
				// works: fail closed, and exit NON-zero below so a supervisor
				// with `Restart=on-failure` restarts it (review on #2637).
				laneStartFailed = true;
				laneStartFailure = outcome.error;
				deps.io.logger.error(
					`Worker lanes failed to start after the first accepted heartbeat: ${describeError(
						outcome.error
					)} — shutting down`
				);
				requestShutdown();
			});
		}
	}
	// The workspace reaper rides with the worker: it is the process that
	// creates worktrees, so it is the one that reclaims them. A
	// heartbeat-only node runs `ever-works-node gc` by hand.
	const reaper =
		worker && runtime.workspaceRoot
			? startWorkspaceReaperTimer({
					rootPath: runtime.workspaceRoot,
					policy: policyFromConfig(workspaceGc),
					logger: deps.io.logger,
					activeBindings: () => runtime.workspaceProvisioner?.activeBindingKeys?.() ?? new Set<string>(),
					isBusy: () => worker.getState().activeJobIds.length > 0,
					// Node housekeeping (EW-803): every completed cycle goes
					// to the heartbeat's reporter, so Fleet can show that this
					// machine is reclaiming — and, more usefully, when it has
					// stopped. Without it the reaper's outcome reached the
					// local log file and nowhere else.
					onResult: (result) => runtime.housekeeping?.record(result),
					...(deps.io.scheduler ? { scheduler: deps.io.scheduler } : {}),
					...(deps.workspaceHousekeeping ? { scan: deps.workspaceHousekeeping.scan } : {}),
					...(deps.workspaceHousekeeping ? { reap: deps.workspaceHousekeeping.reap } : {}),
					...(deps.now ? { now: deps.now } : {})
				})
			: null;
	if (worker?.getState().state === 'unsafe') {
		deps.out(
			'Worker host QUARANTINED — leasing is disabled across restarts. Verify every prior process tree is stopped, then run `ever-works-node clear-quarantine --confirm-process-tree-stopped`.'
		);
	} else if (worker && startPaused) {
		// Loud, because a drained node looks identical to a broken one
		// from the outside: it beats, it appears online, and it never
		// picks anything up.
		deps.out('Worker host PAUSED — heartbeating only. Run `ever-works-node resume` to take work again.');
	} else if (worker) {
		deps.out(
			`Worker host enabled — leasing [${worker.registeredKinds.join(', ')}] within ${describeLimits(effectiveLimits)}`
		);
	}
	if (worker && runtime.workspaceRoot) {
		deps.out(`Workspace reaper — ${describeWorkspaceGc(workspaceGc)}, root ${runtime.workspaceRoot}`);
	}
	if (!worker) {
		// Say so explicitly: an operator who expected this machine to run
		// work should not have to infer it from an absence of log lines.
		deps.out('Worker host disabled — reporting liveness only (pass --work to execute platform work)');
	}
	// Fleet node link (FL-02): which consents this process holds, in one line.
	deps.out(
		isFleetLinkEligible(runtime.consents)
			? `Consents — ${describeConsents(runtime.consents)}; the node link opens after the first accepted heartbeat`
			: 'Consents — none: the node link stays closed and this computer only reports health (pass --work, --attend or --manage)'
	);
	// Usage & cost on the fleet (FL-20, spec S1): say what the scan reads, and what it never reads.
	if (runtime.consents.usageScan) {
		deps.out(`Usage scan on — reads ${FLEET_USAGE_PRIVACY_SENTENCE}`);
	}

	// Block until shutdown is requested: the injected hook (tests) or a signal
	// (the real service). With neither wired there is nothing that could ever
	// wake us, so fall straight through instead of hanging forever.
	await (deps.waitForShutdown?.() ?? (deps.signals ? signalled : Promise.resolve()));

	reaper?.stop();
	shuttingDown = true;
	// The link first: channels end `normal` and nothing reconnects while the
	// lanes below drain.
	runtime.link?.close();
	// Sessions (FL-04): let go of the daemon — never stop it. Every session
	// keeps running and the next node process finds them all.
	runtime.sessions?.module.dispose();
	await runtime.sessions?.status?.stop().catch(() => undefined);
	runtime.sessions?.supervisor.stop();
	loop.stop();
	await loop.settled();
	// A start that was waiting for an accepted beat ends here (the loop is
	// stopped), and one already under way finishes before the drain below.
	await lanesStarted;
	if (attendedWorker) {
		// A live view is open-ended, so draining would wait for ever: end each
		// one now (the executor tells its viewers this machine went away), then
		// stop the lane.
		for (const jobId of attendedWorker.getState().activeJobIds) {
			attendedWorker.cancelJob(jobId, 'This machine is shutting down');
		}
		await attendedWorker.stop();
	}
	if (managementWorker) {
		// Drains like the work lane: a machine job in flight finishes and reports.
		await managementWorker.stop();
	}
	if (worker) {
		// Drains: stops leasing at once, then WAITS for the jobs already
		// running so their verdicts reach the platform instead of being
		// abandoned to a lease expiry and re-run somewhere else.
		await worker.stop();
		const state = worker.getState();
		deps.out(`Worker host stopped (completed ${state.completed}, failed ${state.failed}).`);
	}
	deps.out('Stopped.');
	// Fleet node link (FL-02 T-25): a self-update installed a new binary; exit
	// 75 so the service manager starts it.
	if (restartForUpdate !== null) {
		throw new CliError(
			`Restarting into ever-works-node ${restartForUpdate} (self-update) — exit ${SELF_UPDATE_EXIT_CODE} asks the service manager to start the new binary.`,
			SELF_UPDATE_EXIT_CODE
		);
	}
	if (laneStartFailed) {
		throw new CliError(
			`Worker lanes failed to start after the first accepted heartbeat: ${describeError(laneStartFailure)}`,
			EXIT_FAILURE
		);
	}
}

/**
 * The CLI's deferred lane start (#2628): wait for an ACCEPTED heartbeat, then
 * run `startLanes`, unless `shouldWait()` turned false (a shutdown) first.
 * Never rejects: a failing start is reported as `failed`, so the caller can
 * shut down AND exit non-zero instead of losing the error in a background
 * promise. Exported for its own tests.
 */
export async function startLanesAfterAcceptedHeartbeat(
	loop: Parameters<typeof untilHeartbeatAccepted>[0],
	startLanes: () => Promise<void>,
	shouldWait: () => boolean
): Promise<{ started: boolean; failed: boolean; error?: unknown }> {
	const accepted = await untilHeartbeatAccepted(loop, shouldWait);
	if (!accepted || !shouldWait()) return { started: false, failed: false };
	try {
		await startLanes();
		return { started: true, failed: false };
	} catch (error) {
		return { started: false, failed: true, error };
	}
}

/**
 * `--claude-path` / `--codex-path` re-resolve the model CLIs from the
 * startup answer, with no PATH of their own. A provider no flag re-pinned
 * keeps its startup verdict (boot-probe retry): one whose PATH lookup TIMED OUT stays
 * "probe timed out" — re-resolved without a lookup it would read "not found
 * on PATH", which is exactly the false negative this retry exists to stop.
 */
export function keepStartupTimeouts(
	resolved: ModelCliProbeResult,
	startup: Pick<CapabilityEnvironment, 'modelCliNotes' | 'modelCliTimedOut'>,
	flagged: Readonly<Record<'claude-code' | 'codex', boolean>>
): ModelCliProbeResult {
	const timedOut = (startup.modelCliTimedOut ?? []).filter(
		(provider): provider is 'claude-code' | 'codex' =>
			(provider === 'claude-code' || provider === 'codex') && !flagged[provider]
	);
	if (timedOut.length === 0) return resolved;
	const notes = resolved.notes.map((note) => {
		const provider = timedOut.find((candidate) => note.startsWith(`${candidate}: `));
		if (!provider) return note;
		return startup.modelCliNotes?.find((line) => line.startsWith(`${provider}: `)) ?? note;
	});
	return { ...resolved, notes, timedOut };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Parse `--concurrency`; anything unparseable falls back to the default. */
export function parseConcurrency(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new CliError(`Invalid --concurrency: ${raw} (expected a positive integer)`, EXIT_FAILURE);
	}
	return parsed;
}

export interface PauseCommandOptions {
	/** Skip the API call and only flip the local flag (offline machines). */
	localOnly?: boolean;
}

/** `policy` flags, as commander hands them over: `on` / `off` strings. */
export interface PolicyCommandOptions {
	allowSkipPermissions?: string;
	allowShellCommands?: string;
	restrictedMode?: string;
	allowMcpBridge?: string;
}

/** One line: every local execution-policy switch, in words. */
export function describeExecutionPolicy(policy: NodeExecutionPolicy): string {
	return (
		`skip-permissions ${policy.allowSkipPermissions ? 'ALLOWED' : 'refused'}, ` +
		`node-run shell commands ${policy.allowShellCommands ? 'ALLOWED' : 'refused'}, ` +
		`Claude Code restricted mode ${policy.restrictedMode ? 'on' : 'OFF'}, ` +
		`platform MCP bridge ${policy.allowMcpBridge ? 'allowed' : 'REFUSED'}`
	);
}

function parsePolicySwitch(flag: string, value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'on' || normalized === 'true' || normalized === 'yes') return true;
	if (normalized === 'off' || normalized === 'false' || normalized === 'no') return false;
	throw new CliError(`${flag} takes 'on' or 'off', not '${value}'`);
}

/**
 * Control 18 — show or change the machine owner's local execution policy.
 *
 * Purely local, on purpose: there is no API call, and the platform has no
 * route that writes this. A job asks; this machine decides. A running
 * service reads the policy at start, so a change applies from the next
 * restart — said in the output rather than left to be discovered.
 */
export async function runPolicy(deps: CliDeps, options: PolicyCommandOptions): Promise<void> {
	const config = await requireConfig(deps);
	const current = resolveNodeExecutionPolicy(config.executionPolicy);
	const skip = parsePolicySwitch('--allow-skip-permissions', options.allowSkipPermissions);
	const shell = parsePolicySwitch('--allow-shell-commands', options.allowShellCommands);
	const restricted = parsePolicySwitch('--restricted-mode', options.restrictedMode);
	const mcpBridge = parsePolicySwitch('--allow-mcp-bridge', options.allowMcpBridge);
	if (skip === undefined && shell === undefined && restricted === undefined && mcpBridge === undefined) {
		deps.out(`policy       ${describeExecutionPolicy(current)}`);
		deps.out(
			'Change it with `ever-works-node policy --allow-skip-permissions on|off --allow-shell-commands on|off --restricted-mode on|off --allow-mcp-bridge on|off`.'
		);
		return;
	}
	const next: NodeExecutionPolicy = {
		allowSkipPermissions: skip ?? current.allowSkipPermissions,
		allowShellCommands: shell ?? current.allowShellCommands,
		restrictedMode: restricted ?? current.restrictedMode,
		allowMcpBridge: mcpBridge ?? current.allowMcpBridge
	};
	await saveConfig(
		deps.fs,
		deps.configPath,
		{ ...config, executionPolicy: next },
		{ platform: deps.platform, secrets: deps.secrets ?? null, logger: deps.io.logger }
	);
	deps.out(`policy       ${describeExecutionPolicy(next)}`);
	if (next.allowSkipPermissions) {
		deps.out(
			'WARNING: jobs may now run the model CLI with its permission checks OFF. A prompt injection in a Task, ' +
				'a repository or a review comment then has an unrestricted shell as this account, with no filesystem ' +
				'or network boundary.'
		);
	}
	if (next.allowShellCommands) {
		deps.out(
			'WARNING: jobs may now make this node run shell commands (setup, acceptance checks). They execute ' +
				'repository code as this account — after a model step, code the model may have written.'
		);
	}
	if (!next.restrictedMode) {
		deps.out(
			'Note: Claude Code restricted mode is OFF — runs keep the baseline isolation (no repository settings, no ' +
				'hooks) but get the command-running built-ins back and read your ~/.claude/settings.json.'
		);
	}
	if (!next.allowMcpBridge) {
		deps.out(
			'Note: the platform MCP bridge is OFF — jobs whose Agent has external tools enabled are refused on this ' +
				'machine instead of running with platform tools.'
		);
	}
	deps.out('Restart the node service for a running worker to apply the change.');
}

/**
 * Drain or resume this node.
 *
 * TWO things have to change, and both matter:
 *
 *   1. The PLATFORM stops leasing new work onto the node. Without this,
 *      a local flag would only stop the node from asking — the row
 *      would still look schedulable, and every other surface would
 *      still count the machine as capacity.
 *   2. The LOCAL config records the drain, so a service restart or a
 *      reboot comes back paused instead of quietly resuming.
 *
 * The local flag is written even when the API call fails: an operator
 * draining a machine before pulling its power should not have that
 * intent lost because the network was down. The failure is surfaced,
 * not swallowed.
 */
export async function runPause(deps: CliDeps, paused: boolean, options: PauseCommandOptions = {}): Promise<void> {
	const config = await requireConfig(deps);
	const verb = paused ? 'Paused' : 'Resumed';

	let remoteError: string | null = null;
	if (options.localOnly !== true) {
		try {
			const node = await pauseNode(config, deps.io, paused);
			deps.out(`${verb} node ${config.nodeId} — the platform now reports status '${node.status}'.`);
		} catch (error) {
			remoteError = error instanceof Error ? error.message : String(error);
		}
	}

	await saveConfig(
		deps.fs,
		deps.configPath,
		{ ...config, paused },
		{ platform: deps.platform, secrets: deps.secrets ?? null, logger: deps.io.logger }
	);

	if (options.localOnly === true) {
		deps.out(
			`${verb} node ${config.nodeId} locally. The platform was NOT told — run without --local-only to sync.`
		);
	} else if (remoteError) {
		// Deliberately not fatal: the local intent is recorded, and the
		// node will still stop leasing. Say exactly what did not happen.
		deps.io.logger.warn(
			`Could not reach the platform to ${paused ? 'pause' : 'resume'} this node: ${deps.io.logger.redact(
				remoteError
			)}`
		);
		deps.out(
			`${verb} node ${config.nodeId} locally. The platform still believes it is ${
				paused ? 'available' : 'paused'
			} — re-run this command when connectivity is back.`
		);
	}

	if (paused) {
		deps.out('In-flight jobs keep running and still report their results. Heartbeats continue.');
	}
}

/** Clear only after the operator has independently verified no child survives. */
export async function runClearQuarantine(
	deps: CliDeps,
	options: { confirmProcessTreeStopped?: boolean }
): Promise<void> {
	const config = await requireConfig(deps);
	const safetyGate = createConfigWorkerSafetyGate(deps.fs, deps.configPath, { platform: deps.platform });
	const marker = await safetyGate.inspect();
	if (!config.unsafe && !marker) {
		deps.out('No worker quarantine is recorded.');
		return;
	}
	if (options.confirmProcessTreeStopped !== true) {
		throw new CliError(
			'Refusing to clear quarantine without --confirm-process-tree-stopped. Verify the prior Git/command process tree is no longer running first.'
		);
	}
	if (config.unsafe) {
		const cleared = { ...config };
		delete cleared.unsafe;
		// Config first, marker last: a crash between the two leaves the
		// marker in place and therefore remains fail-closed on restart.
		await saveConfig(deps.fs, deps.configPath, cleared, {
			platform: deps.platform,
			secrets: deps.secrets ?? null,
			logger: deps.io.logger
		});
	}
	await safetyGate.clear();
	deps.out('Quarantine cleared after explicit process-tree verification. Restart the worker to take work.');
}

/**
 * Retire this machine: tell the platform to delete the registration,
 * then erase the local credential.
 *
 * The local erase happens even when the API call fails. A
 * decommissioned laptop with a live fleet secret still on it is the
 * worse outcome by a wide margin, and the platform-side row can always
 * be removed from the Fleet settings page afterwards.
 */
export async function runUnenroll(deps: CliDeps, options: { localOnly?: boolean } = {}): Promise<void> {
	const config = await requireConfig(deps);

	let remoteError: string | null = null;
	if (options.localOnly !== true) {
		try {
			await unenrollNode(config, deps.io);
		} catch (error) {
			remoteError = error instanceof Error ? error.message : String(error);
		}
	}

	await clearConfig(deps.fs, deps.configPath, config, { secrets: deps.secrets ?? null });
	// Schedules on computers (FL-13 P3): whatever the OS-scheduler fallback wrote goes with the enrolment.
	await removeNativeSchedules(deps);

	if (options.localOnly === true) {
		deps.out(`Removed the local credential for node ${config.nodeId}.`);
		deps.out('The platform still lists this node — remove it from the Fleet settings page.');
		return;
	}
	if (remoteError) {
		deps.io.logger.warn(`Could not reach the platform to unenroll: ${deps.io.logger.redact(remoteError)}`);
		deps.out(`Removed the local credential for node ${config.nodeId}, but the platform was NOT told.`);
		deps.out('Remove the node from the Fleet settings page to revoke it there too.');
		return;
	}
	deps.out(`Unenrolled node ${config.nodeId}. The registration and the local credential are both gone.`);
}

/**
 * What every operator-facing surface says about the control plane.
 *
 * Never throws. `resolveApiBase` refuses a malformed `EVER_WORKS_NODE_API_URL`
 * — which is right for the runtime (fail at startup, not at the first request)
 * but wrong for `status` and `doctor`: the one command an operator is told to
 * run when the fleet cannot reach the platform must still print, and must say
 * plainly that the pin is what is broken.
 */
function describeControlPlane(config: Pick<NodeConfig, 'apiUrl'> | null): string {
	if (config) {
		try {
			return describeApiBase(resolveApiBase(config));
		} catch (error) {
			return (
				`${config.apiUrl} (from the enrolled config) — WARNING: ${API_URL_ENV} is set to an ` +
				`invalid URL, so the node will refuse to start: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	try {
		const pinned = readApiUrlPin();
		return pinned === null
			? `not enrolled, nothing pinned (set ${API_URL_ENV} to choose a control plane up front)`
			: `${pinned} (pinned via ${API_URL_ENV}; this machine is not enrolled yet)`;
	} catch (error) {
		return `INVALID ${API_URL_ENV}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** The same facts, for `doctor --json`. Never throws, for the same reason. */
function controlPlaneJson(config: Pick<NodeConfig, 'apiUrl'> | null): Record<string, unknown> {
	try {
		if (config) {
			const base = resolveApiBase(config);
			return {
				apiUrl: base.url,
				apiUrlSource: base.source,
				enrolledApiUrl: base.configuredUrl,
				apiUrlPinMismatch: base.mismatch
			};
		}
		const pinned = readApiUrlPin();
		return {
			apiUrl: pinned,
			apiUrlSource: pinned === null ? 'none' : 'pin',
			enrolledApiUrl: null,
			apiUrlPinMismatch: false
		};
	} catch (error) {
		return {
			apiUrl: config ? config.apiUrl : null,
			apiUrlSource: 'invalid-pin',
			enrolledApiUrl: config ? config.apiUrl : null,
			apiUrlPinMismatch: false,
			apiUrlPinError: error instanceof Error ? error.message : String(error)
		};
	}
}

export async function runStatus(deps: CliDeps): Promise<void> {
	const config = await requireConfig(deps);
	const view = redactConfig(config);
	deps.out(`node id      ${view.nodeId}`);
	deps.out(`name         ${view.name ?? '(assigned by the platform)'}`);
	deps.out(`kind         ${view.kind}`);
	// The EFFECTIVE control plane, and where it came from. Printing only the
	// stored value made a pinned node indistinguishable from an unpinned one
	// (EW-779) — and a pin that does not match the enrolled origin 401s every
	// call, which is worth reading before anything else.
	deps.out(`api          ${describeControlPlane(config)}`);
	deps.out(`enrolled at  ${view.enrolledAt}`);
	deps.out(`heartbeat    every ${view.heartbeatIntervalMs / 1000}s`);
	deps.out(`capabilities ${view.capabilities.join(', ') || '(none)'}`);
	// The secret itself is never printed — only whether one is stored,
	// and where. Naming the location is what makes a silent downgrade to
	// plaintext visible.
	deps.out(`credential   ${view.hasSecret ? 'stored' : 'MISSING'} (${view.secretStorage})`);
	deps.out(`work         ${view.paused ? 'PAUSED (draining — no new work)' : 'accepting new work'}`);
	// Node lifecycle (slice AR): the daemon version floor, as the running
	// service last heard it from the platform.
	const lifecycleRecord = await readNodeLifecycleRecord(deps.fs, deps.configPath);
	deps.out(`daemon       ${describeDaemonLifecycle(deps, lifecycleRecord)}`);
	// Fleet node link (FL-02): the consents the running service holds and
	// its link, as the service last recorded them.
	const linkRecord = await readNodeLinkRecord(deps.fs, deps.configPath);
	deps.out(
		`consents     ${linkRecord ? describeConsents(linkRecord.consents) : 'unknown (the service has not reported them yet)'}`
	);
	// Usage & cost on the fleet (FL-20, spec S1): what the scan reads, and what it never reads.
	deps.out(
		`usage scan   ${
			!linkRecord
				? 'unknown (the service has not reported it yet)'
				: linkRecord.consents?.usageScan === true
					? `on — reads ${FLEET_USAGE_PRIVACY_SENTENCE}`
					: 'off (start the node with --usage-scan to report what its model work would cost)'
		}`
	);
	deps.out(`link         ${describeLinkRecord(linkRecord, (deps.now ?? (() => Date.now()))())}`);
	deps.out(
		`offering     ${view.capabilitySelection ? view.capabilitySelection.join(', ') || '(identity only)' : '(everything detected)'}`
	);
	deps.out(`limits       ${describeLimits(view.limits)}`);
	// Remote node limits (slice AS): the owner's platform ceiling as the
	// running service last heard it, and what the node enforces under it.
	deps.out(`ceiling      ${describePlatformCeiling(lifecycleRecord, view.limits)}`);
	deps.out(`workspace gc ${describeWorkspaceGc(view.workspaceGc ?? DEFAULT_WORKSPACE_GC_POLICY)}`);
	// Control 18: what this machine lets a job do, decided here, never by the platform.
	deps.out(`policy       ${describeExecutionPolicy(view.executionPolicy)}`);
	// The secret itself is never printed — only whether one is stored.
	deps.out(`credential   ${view.hasSecret ? 'stored' : 'MISSING'}`);
	deps.out(`config       ${deps.configPath}`);
}

// ---------------------------------------------------------------------------
// doctor / gc — disk headroom and the workspace reaper (self-build §6)
// ---------------------------------------------------------------------------

export interface HousekeepingCommandOptions {
	/** Same rule as `start --workspace-root`: absolute, never a filesystem root. */
	workspaceRoot?: string;
	/** Override the stored max age, in days, for this invocation only. */
	maxAge?: string;
	/** Override the stored count budget for this invocation only. */
	maxCount?: string;
	/** Do not consult remotes. Nothing is ever removed offline — every remote fact reads as unknown. */
	offline?: boolean;
}

export interface DoctorCommandOptions extends HousekeepingCommandOptions {
	json?: boolean;
}

export interface GcCommandOptions extends HousekeepingCommandOptions {
	dryRun?: boolean;
}

/** Where `doctor` / `gc` got the root they are inspecting. Printed, because getting it wrong is silent. */
export type HousekeepingRootSource = 'flag' | 'config' | 'default';

interface HousekeepingReport {
	config: NodeConfig | null;
	workspaceRoot: string;
	workspaceRootSource: HousekeepingRootSource;
	floor: number | null;
	freeBytes: number | null;
	policy: NodeWorkspaceGcPolicy;
	workerSessionActive: boolean;
	inventory: WorkspaceInventory;
	plan: WorkspaceReapPlan;
}

/**
 * Everything `doctor` prints and `gc` acts on, gathered once. Works whether
 * or not the machine is enrolled: the config only supplies the floor and
 * the reaper policy, and an un-enrolled node has defaults for both.
 */
async function gatherHousekeeping(deps: CliDeps, options: HousekeepingCommandOptions): Promise<HousekeepingReport> {
	// Usage errors first, before anything is read.
	const rootFlag = parseWorkspaceRoot(options.workspaceRoot, deps.platform);
	const maxAgeDays = parseBounded(
		options.maxAge,
		'--max-age',
		MIN_WORKSPACE_MAX_AGE_DAYS,
		MAX_WORKSPACE_MAX_AGE_DAYS
	);
	const maxCount = parseBounded(options.maxCount, '--max-count', MIN_WORKSPACE_COUNT, MAX_WORKSPACE_COUNT);
	const now = deps.now ?? (() => Date.now());

	const config = await loadConfig(deps.fs, deps.configPath, loadOptions(deps));
	// Precedence: the flag the operator typed, then the root the SERVICE
	// recorded on its last `start`, then the process default. The middle
	// step is the one that was missing: without it these two commands
	// inspected `homedir()` — the account running the CLI, not the service
	// account — and answered "0 worktree(s), 0 B" about the wrong tree
	// (review AO-6).
	const workspaceRoot = rootFlag ?? config?.workspaceRoot ?? defaultFleetTaskWorkspaceRoot(process.env);
	const workspaceRootSource: HousekeepingRootSource = rootFlag
		? 'flag'
		: config?.workspaceRoot
			? 'config'
			: 'default';
	const limits = clampResourceLimits(config?.limits);
	const floor = effectiveMinFreeDiskBytes(limits);
	const policy = clampWorkspaceGcPolicy({
		...(config?.workspaceGc ?? DEFAULT_WORKSPACE_GC_POLICY),
		...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
		...(maxCount !== undefined ? { maxCount } : {})
	});
	const freeBytes = deps.io.diskProbe ? await measureWorkspaceFreeBytes(deps.io.diskProbe, workspaceRoot) : null;

	// A worker-session marker means a worker MAY be alive on this config.
	// Its jobs lease their worktrees, so the reaper still knows which ones
	// are busy — except a worktree from before leases existed, which is
	// kept while the marker stands (`requireUsageRecord`). An unreadable
	// marker counts as present: that is the fail-closed side.
	let workerSessionActive = false;
	try {
		workerSessionActive =
			(await createConfigWorkerSafetyGate(deps.fs, deps.configPath, { platform: deps.platform }).inspect()) !==
			null;
	} catch {
		workerSessionActive = true;
	}

	const scan = deps.workspaceHousekeeping?.scan ?? scanWorkspaceRoot;
	const inventory = await scan(workspaceRoot, { refreshRemote: options.offline !== true, now });
	const plan = planWorkspaceReap(
		inventory,
		{ ...policyFromConfig(policy), requireUsageRecord: workerSessionActive },
		now()
	);
	return {
		config,
		workspaceRoot,
		workspaceRootSource,
		floor,
		freeBytes,
		policy,
		workerSessionActive,
		inventory,
		plan
	};
}

function printHousekeepingHeader(deps: CliDeps, report: HousekeepingReport, now: number): void {
	deps.out(`enrolled     ${report.config ? `yes (node ${report.config.nodeId})` : 'no — defaults apply'}`);
	// `doctor` printed nothing at all about the control plane before EW-779,
	// which made "the fleet cannot reach the platform" undiagnosable from the
	// one command an operator is told to run.
	deps.out(`api          ${describeControlPlane(report.config)}`);
	// The provenance, always — an operator reading "0 worktree(s), 0 B"
	// has to be able to tell "this machine is tidy" from "I am looking at
	// the wrong tree", and the wrong tree is the likelier of the two when
	// the service runs as another account (review AO-6).
	const rootSource =
		report.workspaceRootSource === 'flag'
			? ' (from --workspace-root)'
			: report.workspaceRootSource === 'config'
				? " (from this node's last `start`)"
				: ' (default — NOT recorded by any `start`; if the service runs as another account or with' +
					' --workspace-root, this is not its tree: pass --workspace-root)';
	deps.out(`workspace    ${report.workspaceRoot}${report.inventory.exists ? '' : ' (not created yet)'}${rootSource}`);
	const floorText = report.floor === null ? 'no floor' : `floor ${formatBytes(report.floor)}`;
	if (report.freeBytes === null) {
		// The only place `doctor` explains a node that has gone quiet with
		// no visible disk problem. Both branches are pinned by
		// `program.housekeeping.spec.ts` (review AO-13); they differ because
		// a floor that was switched off refuses nothing, while a floor in
		// force fails CLOSED on a reading it cannot take — at the lease and
		// at provisioning alike (review AO-11), so the node throttles rather
		// than leasing work it will only defer.
		deps.out(
			report.floor === null
				? `disk free    unknown on the workspace volume (${floorText})`
				: `disk free    unknown on the workspace volume (${floorText}) — this node will not lease or provision until the volume can be read; \`--no-disk-floor\` switches the floor off explicitly`
		);
	} else if (report.floor !== null && report.freeBytes < report.floor) {
		deps.out(
			`disk free    ${formatBytes(report.freeBytes)} on the workspace volume (${floorText}) — BELOW FLOOR: this node will not lease or provision`
		);
	} else {
		deps.out(`disk free    ${formatBytes(report.freeBytes)} on the workspace volume (${floorText})`);
	}
	deps.out(
		`workspace gc ${describeWorkspaceGc(report.policy)}${report.inventory.remoteRefreshed ? '' : ' (offline: nothing is removable)'}`
	);
	if (report.workerSessionActive) {
		deps.out('worker       session marker present — workspaces without a usage record are kept');
	}
	const worktrees = report.inventory.repositories.flatMap((repository) => repository.worktrees);
	const pools = report.inventory.repositories.flatMap((repository) => repository.pools);
	const oldest = worktrees.reduce<number | null>(
		(age, tree) => (tree.lastUsedAt === null ? age : Math.max(age ?? 0, now - tree.lastUsedAt)),
		null
	);
	deps.out(
		`workspaces   ${worktrees.length} worktree(s), ${pools.length} pool(s), ${formatBytes(report.inventory.totalBytes)}${
			oldest === null ? '' : `, oldest unused for ${describeAge(oldest)}`
		}`
	);
	const unrecognised = [
		...report.inventory.unrecognised,
		...report.inventory.repositories.flatMap((repository) => repository.unrecognised)
	];
	for (const path of unrecognised) {
		deps.out(`unrecognised ${path} (left alone)`);
	}
}

function printPlan(deps: CliDeps, plan: WorkspaceReapPlan, now: number): void {
	const row = (verdict: 'REMOVE' | 'KEEP', record: WorkspaceReapPlan['remove'][number]['record'], reason: string) => {
		const age = record.lastUsedAt === null ? 'age ?' : describeAge(now - record.lastUsedAt);
		deps.out(
			`  ${verdict.padEnd(6)} ${(record.bindingKey ?? record.path).padEnd(38)} ${(record.branch ?? '?').padEnd(32)} ${age.padStart(7)} ${formatBytes(record.sizeBytes).padStart(9)}  ${reason}`
		);
	};
	for (const verdict of plan.remove) row('REMOVE', verdict.record, verdict.reason);
	for (const verdict of plan.keep) row('KEEP', verdict.record, verdict.reason);
	for (const verdict of plan.removePools) {
		deps.out(
			`  REMOVE pool ${verdict.pool.path} ${formatBytes(verdict.pool.sizeBytes).padStart(9)}  ${verdict.reason}`
		);
	}
	for (const verdict of plan.keepPools) {
		deps.out(
			`  KEEP   pool ${verdict.pool.path} ${formatBytes(verdict.pool.sizeBytes).padStart(9)}  ${verdict.reason}`
		);
	}
	deps.out(
		`gc would remove ${plan.remove.length} worktree(s) and ${plan.removePools.length} pool(s) (${formatBytes(
			plan.reclaimableBytes
		)}), keep ${plan.keep.length} worktree(s) and ${plan.keepPools.length} pool(s)`
	);
}

function housekeepingJson(report: HousekeepingReport): Record<string, unknown> {
	const verdict = (entry: { record: WorkspaceReapPlan['remove'][number]['record']; reason: string }) => ({
		path: entry.record.path,
		bindingKey: entry.record.bindingKey,
		branch: entry.record.branch,
		lastUsedAt: entry.record.lastUsedAt === null ? null : new Date(entry.record.lastUsedAt).toISOString(),
		sizeBytes: entry.record.sizeBytes,
		reason: entry.reason
	});
	const poolVerdict = (entry: { pool: WorkspaceReapPlan['removePools'][number]['pool']; reason: string }) => ({
		path: entry.pool.path,
		sizeBytes: entry.pool.sizeBytes,
		reason: entry.reason
	});
	return {
		enrolled: report.config !== null,
		...controlPlaneJson(report.config),
		workspaceRoot: report.workspaceRoot,
		workspaceRootSource: report.workspaceRootSource,
		workspaceRootExists: report.inventory.exists,
		diskFreeBytes: report.freeBytes,
		minFreeDiskBytes: report.floor,
		belowFloor: report.floor !== null && report.freeBytes !== null && report.freeBytes < report.floor,
		workspaceGc: report.policy,
		remoteRefreshed: report.inventory.remoteRefreshed,
		workerSessionActive: report.workerSessionActive,
		totalBytes: report.inventory.totalBytes,
		reclaimableBytes: report.plan.reclaimableBytes,
		remove: report.plan.remove.map(verdict),
		keep: report.plan.keep.map(verdict),
		removePools: report.plan.removePools.map(poolVerdict),
		keepPools: report.plan.keepPools.map(poolVerdict),
		unrecognised: [
			...report.inventory.unrecognised,
			...report.inventory.repositories.flatMap((repository) => repository.unrecognised)
		]
	};
}

// ---------------------------------------------------------------------------
// Node lifecycle — daemon version floor + model-CLI compatibility (slice AR)
// ---------------------------------------------------------------------------

interface LifecycleReport {
	record: NodeLifecycleRecord | null;
	modelCli: ModelCliCompatibility[];
	config: NodeConfig | null;
}

async function gatherLifecycle(deps: CliDeps, config: NodeConfig | null): Promise<LifecycleReport> {
	const record = await readNodeLifecycleRecord(deps.fs, deps.configPath);
	const probe = new ModelCliCompatibilityProbe({
		runner: deps.io.runner,
		platform: deps.platform,
		...(deps.io.statFile ? { statFile: deps.io.statFile } : {})
	});
	let modelCli: ModelCliCompatibility[] = [];
	try {
		modelCli = await probe.probeAll(deps.io.environment.modelCli ?? {});
	} catch {
		modelCli = [];
	}
	return { record, modelCli, config };
}

/**
 * One line on this daemon vs the platform's floor. `deps.io.version` is the
 * binary RUNNING THIS COMMAND; the record is what the SERVICE last heard.
 * They differ right after `npm install -g` and before the service restart —
 * exactly when an operator runs `doctor` to check the upgrade took.
 */
function describeDaemonLifecycle(deps: CliDeps, record: NodeLifecycleRecord | null): string {
	const local = deps.io.version;
	if (!record) {
		return `${local} (the platform's minimum version has not been reported yet — it arrives on the running service's first heartbeat)`;
	}
	// The verdict is about the RUNNING SERVICE — the process that holds the
	// work lane — so it is the platform's own answer to that service, never
	// this binary's version (review). The two differ whenever another
	// install or PATH order resolves the CLI, and right after an upgrade.
	const floor = record.minNodeVersion;
	const asOf = `as of ${record.recordedAt}`;
	const service = record.daemonVersion || local;
	const localBelow = floor !== null && isFleetNodeVersionBelowFloor(local, floor);
	if (record.upgradeRequired) {
		const fix =
			local !== service && !localBelow
				? `This command's binary is already ${local} — restart the node service to run it`
				: `Run \`${FLEET_NODE_UPGRADE_COMMAND}\` ${NODE_SOURCE_UPGRADE_HINT}, then restart the node service`;
		return `${service} (running service) — UPGRADE REQUIRED: below the platform's minimum ${floor ?? '(not named)'} (${asOf}); it is offered no new work. ${fix}`;
	}
	// A restart is only advice when this binary is NEWER than the service
	// (review): recommending one for an older binary would be a downgrade.
	const localVsService = compareFleetNodeVersions(local, service);
	const note =
		local === service
			? ''
			: localBelow
				? `; this command's binary is ${local}, below that minimum — another install on PATH? The running service itself is admitted`
				: localVsService === 1
					? `; this command's binary is ${local} — restart the node service to run it`
					: `; this command's binary is ${local}, ${localVsService === -1 ? 'older than' : 'not comparable with'} the running service — another install on PATH? No restart needed`;
	return `${service} (running service; platform minimum ${floor ?? 'not named'}, ${asOf})${note}`;
}

/** One line per pinned model CLI: what it is and whether this node can drive it. */
function describeModelCli(compat: ModelCliCompatibility): string {
	const head = `${compat.provider} ${compat.version ?? 'version unknown'} (${compat.executable})`;
	if (compat.supportedFlags === null) {
		return `${head} — could not verify its flags: ${compat.note ?? 'no answer'}`;
	}
	if (!isModelCliCompatible(compat)) {
		return `${head} — INCOMPATIBLE: does not advertise ${compat.missingRequiredFlags.join(', ')}, which every ${compat.provider} run passes; runs on this machine will fail until the CLI is upgraded or re-pinned`;
	}
	const notes: string[] = [];
	if (compat.unsupportedOptionalFlags.length > 0) {
		notes.push(`runs go without ${compat.unsupportedOptionalFlags.join(', ')} (not advertised by this build)`);
	}
	if (compat.missingConditionalFlags.length > 0) {
		notes.push(`runs that need ${compat.missingConditionalFlags.join(', ')} will fail here`);
	}
	if ((compat.missingHardeningFlags ?? []).length > 0) {
		notes.push(
			`runs go without the stricter ${compat.missingHardeningFlags.join(', ')} mode (upgrade the CLI to get it)`
		);
	}
	return `${head} — compatible${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`;
}

/**
 * Remote node limits (self-build slice AS) — the owner's platform ceiling,
 * as the running service last heard it, and the limits this node enforces
 * under it: `min(local, ceiling)` per dimension. `local` is the STORED
 * config; a service started with one-off `--max-cpu` style overrides
 * enforces the lower of those instead, and logs it.
 */
function describePlatformCeiling(record: NodeLifecycleRecord | null, local: NodeResourceLimits): string {
	const ceiling = record?.limitCeiling ?? null;
	if (!record) return 'not reported yet (it arrives on the running service’s first heartbeat)';
	if (
		!ceiling ||
		(ceiling.maxConcurrentJobs === null && ceiling.maxCpuPercent === null && ceiling.maxMemoryMb === null)
	) {
		return `none set on the platform (as of ${record.recordedAt}) — this node runs on its own limits`;
	}
	const parts = [
		ceiling.maxConcurrentJobs === null ? null : `${ceiling.maxConcurrentJobs} concurrent job(s)`,
		ceiling.maxCpuPercent === null ? null : `CPU < ${ceiling.maxCpuPercent}%`,
		ceiling.maxMemoryMb === null ? null : `memory < ${ceiling.maxMemoryMb}MB`
	].filter((part): part is string => part !== null);
	const effective = applyNodeLimitCeiling(clampResourceLimits(local), ceiling);
	return `${parts.join(', ')} set on the platform (as of ${record.recordedAt}) — enforcing ${describeLimits(effective)}`;
}

function printLifecycle(deps: CliDeps, report: LifecycleReport): void {
	deps.out(`daemon       ${describeDaemonLifecycle(deps, report.record)}`);
	deps.out(`ceiling      ${describePlatformCeiling(report.record, clampResourceLimits(report.config?.limits))}`);
	if (report.modelCli.length === 0) {
		deps.out(
			'model cli    none pinned in this shell (no claude / codex resolved — set EVER_WORKS_NODE_CLAUDE_PATH / EVER_WORKS_NODE_CODEX_PATH; a service started with --claude-path / --codex-path pins its own)'
		);
		return;
	}
	for (const compat of report.modelCli) {
		deps.out(`model cli    ${describeModelCli(compat)}`);
	}
}

function lifecycleJson(deps: CliDeps, report: LifecycleReport): Record<string, unknown> {
	const floor = report.record?.minNodeVersion ?? null;
	return {
		daemonVersion: deps.io.version,
		minNodeVersion: floor,
		minNodeVersionRecordedAt: report.record?.recordedAt ?? null,
		serviceDaemonVersion: report.record?.daemonVersion || null,
		// The platform's verdict on the RUNNING SERVICE (review), and separately
		// whether the binary running this command would be below the floor.
		upgradeRequired: report.record?.upgradeRequired === true,
		localBinaryBelowFloor: floor !== null && isFleetNodeVersionBelowFloor(deps.io.version, floor),
		upgradeCommand: FLEET_NODE_UPGRADE_COMMAND,
		sourceUpgradeHint: NODE_SOURCE_UPGRADE_HINT,
		// Remote node limits (slice AS).
		limitCeiling: report.record?.limitCeiling ?? null,
		effectiveLimits: (() => {
			const effective = applyNodeLimitCeiling(
				clampResourceLimits(report.config?.limits),
				report.record?.limitCeiling ?? null
			);
			return {
				maxConcurrentJobs: effective.maxConcurrentJobs,
				maxCpuPercent: effective.maxCpuPercent,
				maxMemoryMb: effective.maxMemoryMb
			};
		})(),
		modelCli: report.modelCli.map((compat) => ({
			provider: compat.provider,
			executable: compat.executable,
			version: compat.version,
			verified: compat.supportedFlags !== null,
			compatible: compat.supportedFlags === null ? null : isModelCliCompatible(compat),
			missingRequiredFlags: compat.missingRequiredFlags,
			missingConditionalFlags: compat.missingConditionalFlags,
			unsupportedOptionalFlags: compat.unsupportedOptionalFlags,
			missingHardeningFlags: compat.missingHardeningFlags ?? [],
			note: compat.note
		}))
	};
}

/** Startup log for `start --work`: never throws, never blocks the heartbeat. */
async function logModelCliCompatibility(
	deps: CliDeps,
	probe: ModelCliCompatibilityProbe,
	paths: ModelCliPaths
): Promise<void> {
	try {
		for (const compat of await probe.probeAll(paths)) {
			const line = `Model CLI — ${describeModelCli(compat)}`;
			if (compat.supportedFlags !== null && !isModelCliCompatible(compat)) deps.io.logger.error(line);
			else if (compat.supportedFlags === null || compat.unsupportedOptionalFlags.length > 0) {
				deps.io.logger.warn(line);
			} else deps.io.logger.info(line);
		}
	} catch {
		// The probe never throws by contract; this is the belt.
	}
}

/** `doctor`: read-only. Exit 0 even when below the floor — the finding IS the output. */
export async function runDoctor(deps: CliDeps, options: DoctorCommandOptions): Promise<void> {
	const report = await gatherHousekeeping(deps, options);
	// Node lifecycle (slice AR): daemon version vs floor, CLI compatibility.
	const lifecycle = await gatherLifecycle(deps, report.config);
	const now = (deps.now ?? (() => Date.now()))();
	// Sessions on computers (FL-04): the session daemon, asked read-only.
	const sessions = await describeSessionDaemon(deps);
	// Virtual computers (FL-16 P3, T-36): what each system is pinned to here.
	const virtual = await describeVirtualCatalogue(deps);
	if (options.json === true) {
		deps.out(
			JSON.stringify(
				{ ...housekeepingJson(report), ...lifecycleJson(deps, lifecycle), sessions, virtual },
				null,
				2
			)
		);
		return;
	}
	printHousekeepingHeader(deps, report, now);
	printLifecycle(deps, lifecycle);
	// Fleet node link (FL-02): consents and link, as the service last recorded them.
	const linkRecord = await readNodeLinkRecord(deps.fs, deps.configPath);
	deps.out(
		`consents     ${linkRecord ? describeConsents(linkRecord.consents) : 'unknown (the service has not reported them yet)'}`
	);
	deps.out(`link         ${describeLinkRecord(linkRecord, now)}`);
	deps.out(
		`sessions     ${
			sessions.daemon === 'running'
				? `daemon running, ${sessions.sessions ?? 0} session(s), terminal ${sessions.pty === 'available' ? 'available' : `missing — ${sessions.reason ?? 'unknown'}`}`
				: `daemon not running — ${sessions.reason ?? 'unknown'}`
		}`
	);
	if (virtual) {
		const pinned = virtual.catalogue.filter((entry) => entry.digest).length;
		deps.out(
			`virtual      ${pinned} of ${virtual.catalogue.length} Container system(s) pinned here; Windows installer image ${
				virtual.windowsImage ?? 'not configured'
			}`
		);
	}
	printPlan(deps, report.plan, now);
}

/**
 * Virtual computers (FL-16 P3, T-36) — the host's system catalogue as it stands
 * here: each Container system's image, the digest it is pinned to (or not yet),
 * and where that came from (the catalogue, the lock file, an operator
 * override); and the operator's Windows installer image. Null on Windows (no
 * virtual computers there). Never throws.
 */
export async function describeVirtualCatalogue(deps: CliDeps): Promise<{
	catalogue: Array<{ systemId: string; ref: string; digest: string | null; source: string }>;
	windowsImage: string | null;
} | null> {
	if (deps.platform === 'win32') return null;
	try {
		const lockPath = posix.join(posix.dirname(deps.configPath), 'virtual', 'catalogue.lock.json');
		const lock = parseCatalogueLock(await deps.fs.readFile(lockPath).catch(() => null));
		const catalogue: Array<{ systemId: string; ref: string; digest: string | null; source: string }> = [];
		for (const systemId of Object.keys(VIRTUAL_CONTAINER_IMAGES) as FleetVirtualSystemId[]) {
			const image = resolveVirtualImage(systemId, { env: process.env, lock });
			if (image) catalogue.push({ systemId, ref: image.ref, digest: image.digest, source: image.source });
		}
		return { catalogue, windowsImage: resolveWindowsImage(process.env)?.ref ?? null };
	} catch {
		return null;
	}
}

/** `gc`: plan, then reap — unless `--dry-run`, which prints the plan and writes nothing. */
export async function runGc(deps: CliDeps, options: GcCommandOptions): Promise<void> {
	const report = await gatherHousekeeping(deps, options);
	const now = deps.now ?? (() => Date.now());
	printHousekeepingHeader(deps, report, now());
	if (options.dryRun === true) {
		printPlan(deps, report.plan, now());
		deps.out('Dry run — nothing was removed.');
		return;
	}
	const reap = deps.workspaceHousekeeping?.reap ?? runWorkspaceReap;
	const result: WorkspaceReapResult = await reap(report.plan, { logger: deps.io.logger, now });
	for (const removed of result.removed) {
		deps.out(`  removed ${removed.record.bindingKey ?? removed.record.path} (${formatBytes(removed.freedBytes)})`);
	}
	for (const removed of result.removedPools) {
		deps.out(`  removed pool ${removed.pool.path} (${formatBytes(removed.freedBytes)})`);
	}
	for (const kept of result.kept) {
		deps.out(`  kept    ${kept.record.bindingKey ?? kept.record.path}: ${kept.reason}`);
	}
	for (const kept of result.keptPools) {
		deps.out(`  kept    pool ${kept.pool.path}: ${kept.reason}`);
	}
	deps.out(
		`Removed ${result.removed.length} worktree(s) and ${result.removedPools.length} pool(s), freed ${formatBytes(
			result.freedBytes
		)}; kept ${result.kept.length} worktree(s).`
	);
	if (result.errors.length > 0) {
		throw new CliError(
			`${result.errors.length} removal(s) failed — nothing was force-deleted:\n  ${result.errors.join('\n  ')}`
		);
	}
}

export async function runCapabilities(deps: CliDeps): Promise<void> {
	const description = await describeSelf(deps.io.runner, deps.io.environment, deps.io.version);
	deps.out(`platform     ${description.platform}`);
	deps.out(`version      ${description.version}`);
	deps.out(`capabilities ${description.capabilities.join(', ')}`);
	// Name the browser explicitly: `browser` is the one tag that commits
	// this machine to launching a specific executable, and an operator
	// debugging a failed browser-check needs to know WHICH one.
	deps.out(`browser      ${deps.io.environment.browserPath ?? '(none found — `browser` not advertised)'}`);
	deps.out(`display      ${deps.io.environment.hasDisplay ? 'available' : 'headless'}`);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export function buildProgram(deps: CliDeps): Command {
	const program = new Command();
	program
		.name('ever-works-node')
		.description('Ever Works Node — run this machine as a platform execution node')
		.version(deps.io.version)
		// Unknown flags are an error, never a silently ignored typo.
		.allowUnknownOption(false)
		.allowExcessArguments(false)
		// IMPORTANT: `exitOverride` and `configureOutput` must be set BEFORE the
		// subcommands below — commander copies both into each subcommand at
		// `.command()` time (`copyInheritedSettings`), so configuring them
		// afterwards would leave subcommand errors calling `process.exit` and
		// writing straight to the real stdio.
		.exitOverride()
		// One output path for the whole CLI: commander's help/usage text goes
		// through the same injected sinks as everything else.
		.configureOutput({
			writeOut: (str) => deps.out(str.replace(/\n$/, '')),
			writeErr: (str) => deps.io.logger.error(str.replace(/\n$/, ''))
		});

	program
		.command('enroll')
		.description('Enroll this machine using a one-time token from the Fleet settings page')
		.requiredOption('-a, --api-url <url>', 'Platform API base URL (e.g. https://api.ever.works)')
		.option('-t, --token <token>', 'One-time enrollment token (single-use, expires in 15 minutes)')
		.option(
			'--token-file <file>',
			'Read the one-time token from this file instead (owner-only, 0600; deleted after it is read). Exactly one of --token / --token-file'
		)
		.option('-n, --name <name>', 'Local display label (the platform assigns the authoritative name)')
		.option(
			'-i, --heartbeat-interval <seconds>',
			`Heartbeat cadence in seconds (default ${DEFAULT_HEARTBEAT_INTERVAL_MS / 1000})`
		)
		.option(
			'--capabilities <tags>',
			'Comma-separated capability tags to OFFER (default: everything detected). Machine identity tags (os/arch/node) are always advertised.'
		)
		.option(
			'-c, --concurrency <count>',
			`Max jobs to execute at once (${MIN_CONCURRENT_JOBS}-${MAX_CONCURRENT_JOBS})`
		)
		.option(
			'--max-cpu <percent>',
			`Refuse new work while host CPU is at or above this percent (${MIN_CPU_PERCENT}-${MAX_CPU_PERCENT})`
		)
		.option(
			'--max-memory <mb>',
			`Refuse new work while host memory in use is at or above this many MB (min ${MIN_MEMORY_MB})`
		)
		.option(
			'--min-free-disk <mib>',
			`Refuse new work while the workspace volume has fewer free MiB than this (default ${formatBytes(
				effectiveMinFreeDiskBytes({}) ?? 0
			)}, min ${MIN_MIN_FREE_DISK_BYTES / MIB} MiB)`
		)
		.option('--no-disk-floor', 'Switch the disk floor off entirely (not recommended)')
		.option(
			'--workspace-max-age <days>',
			`Remove Task worktrees proven safe and unused for longer than this (default ${DEFAULT_WORKSPACE_MAX_AGE_DAYS})`
		)
		.option(
			'--workspace-max-count <count>',
			'Additionally keep at most this many worktrees (least recently used go first)'
		)
		.action(async (options: EnrollCommandOptions) => {
			await runEnroll(deps, options);
		});

	program
		.command('start')
		.description('Run the heartbeat loop (and, with --work, the job worker host) until SIGINT/SIGTERM')
		.option('-i, --heartbeat-interval <seconds>', 'Override the stored heartbeat cadence, in seconds')
		.option('-w, --work', 'Lease and execute platform work on this machine (off by default)')
		.option(
			'--attend',
			'Allow live viewing of this machine from the dashboard (off by default; independent of --work)'
		)
		.option(
			'--manage',
			'Allow managing this machine from the dashboard — owner sessions, logs, services, Docker, processes, ports, files, commands, schedules (off by default; independent of --work and --attend)'
		)
		.option(
			'--usage-scan',
			'Report what the model work on this machine would cost: reads token counts, models and session ids from Claude Code and Codex records — never prompts, output or file contents (off by default)'
		)
		.option(
			'--auto-update',
			'Upgrade this node itself when the platform raises its minimum version or names a recommended one (waits for running jobs; npm installs only; off by default)'
		)
		.option(
			'--files-root <dir>',
			'With --manage: share this folder with the dashboard (the Files tab browses it, the Logs tab lists the log files under it); repeatable',
			(value: string, previous: string[] = []) => [...previous, value]
		)
		.option(
			'-c, --concurrency <count>',
			'Max jobs to execute at once when --work is set (overrides the stored limit)'
		)
		.option('--max-cpu <percent>', 'Override the stored CPU admission ceiling, in percent')
		.option('--max-memory <mb>', 'Override the stored memory admission ceiling, in MB')
		.option('--min-free-disk <mib>', 'Override the stored disk floor for this process, in MiB (1 MiB = 1024 KiB)')
		.option('--no-disk-floor', 'Switch the disk floor off for this process (not recommended)')
		.option(
			'--workspace-max-age <days>',
			'Set (and persist) the max age after which safe, unused Task worktrees are removed'
		)
		.option('--workspace-max-count <count>', 'Set (and persist) a count budget for Task worktrees')
		.option(
			'--claude-path <file>',
			'Claude Code executable used for model-cli agent tasks (default: EVER_WORKS_NODE_CLAUDE_PATH, then PATH)'
		)
		.option(
			'--codex-path <file>',
			'Codex executable used for model-cli agent tasks (default: EVER_WORKS_NODE_CODEX_PATH, then PATH)'
		)
		.option(
			'--workspace-root <dir>',
			'Absolute directory for the persistent per-Task worktrees of agent tasks (default: EVER_WORKS_NODE_WORKSPACE_ROOT, then ~/.ever-works/fleet-workspaces)'
		)
		.option(
			'--native-schedules',
			"With --manage and when not running as a service: also hand this machine's schedules to the OS scheduler (crontab / LaunchAgents / Task Scheduler) so they run while the node is closed"
		)
		.option(
			'--code-folder <dir>',
			'A folder you keep code in; Ever Works lists the git clones under it, three folders deep (repeatable; persisted; needs --manage)',
			(value: string, previous: string[] = []) => [...previous, value]
		)
		.action(async (options: StartCommandOptions) => {
			await runStart(deps, options);
		});

	program
		.command('pause')
		.description('Drain this node: stop taking new work, finish what is already running')
		.option('--local-only', 'Only set the local flag; do not tell the platform (offline machines)')
		.action(async (options: PauseCommandOptions) => {
			await runPause(deps, true, options);
		});

	program
		.command('resume')
		.description('Take work again after a pause')
		.option('--local-only', 'Only clear the local flag; do not tell the platform')
		.action(async (options: PauseCommandOptions) => {
			await runPause(deps, false, options);
		});

	program
		.command('policy')
		.description(
			'Show or change what platform jobs may make this machine do (local only; the platform cannot change it)'
		)
		.option(
			'--allow-skip-permissions <on|off>',
			'Let jobs run the model CLI with its permission checks off (--dangerously-skip-permissions). Default off.'
		)
		.option(
			'--allow-shell-commands <on|off>',
			'Let jobs make this node run shell commands: setup, command steps, acceptance checks. Default off.'
		)
		.option(
			'--restricted-mode <on|off>',
			'Run Claude Code with --restricted when it supports it (no shell tools, no settings files). Default on.'
		)
		.option(
			'--allow-mcp-bridge <on|off>',
			'Let jobs start the platform MCP bridge (platform tools for the model, run-scoped credential). Default on.'
		)
		.action(async (options: PolicyCommandOptions) => {
			await runPolicy(deps, options);
		});

	program
		.command('clear-quarantine')
		.description('Clear a persisted unsafe worker state after verifying every prior process tree is stopped')
		.option(
			'--confirm-process-tree-stopped',
			'Assert that the prior Git/command process tree has been independently verified stopped'
		)
		.action(async (options: { confirmProcessTreeStopped?: boolean }) => {
			await runClearQuarantine(deps, options);
		});

	program
		.command('unenroll')
		.description('Retire this node: delete its platform registration and erase the local credential')
		.option('--local-only', 'Only erase the local credential; leave the platform registration in place')
		.action(async (options: { localOnly?: boolean }) => {
			await runUnenroll(deps, options);
		});

	program
		.command('status')
		.description('Show this machine’s enrollment (credentials redacted)')
		.action(async () => {
			await runStatus(deps);
		});

	program
		.command('capabilities')
		.description('Print the capability tags this machine reports')
		.action(async () => {
			await runCapabilities(deps);
		});

	program
		.command('doctor')
		.description('Report disk headroom against the floor and what the workspace reaper would do (read-only)')
		.option('--workspace-root <dir>', 'Absolute workspace root to inspect (default: the same as `start`)')
		.option('--max-age <days>', 'Judge against this max age instead of the stored one')
		.option('--max-count <count>', 'Judge against this count budget instead of the stored one')
		.option('--offline', 'Do not consult remotes (every remote fact then reads as unknown)')
		.option('--json', 'Emit the report as one JSON object')
		.action(async (options: DoctorCommandOptions) => {
			await runDoctor(deps, options);
		});

	program
		.command('gc')
		.description('Run the workspace reaper: remove Task worktrees proven safe to remove and older than the max age')
		.option('--workspace-root <dir>', 'Absolute workspace root to reap (default: the same as `start`)')
		.option('--max-age <days>', 'Use this max age instead of the stored one')
		.option('--max-count <count>', 'Use this count budget instead of the stored one')
		.option('--dry-run', 'Print the plan and remove nothing')
		.option('--offline', 'Do not consult remotes — nothing is removable offline; useful with --dry-run')
		.action(async (options: GcCommandOptions) => {
			await runGc(deps, options);
		});

	// Desktop view & control (FL-07): the native screen helper's admission — on
	// this machine, by the person at its keyboard, never from the web (FR-15).
	const helper = program
		.command('helper')
		.description('The native screen helper that shows this computer’s desktop in a live view (Desktop source)');
	helper
		.command('install')
		.description(
			'Download the screen helper this node version publishes for this platform and check its fingerprint'
		)
		.action(async () => {
			await runHelperCommand(deps, (helperDeps) => helperInstall(helperDeps));
		});
	helper
		.command('admit')
		.description('Approve the screen helper on this machine after comparing its fingerprint (type "admit")')
		.option('--path <file>', 'Approve this helper file instead of the installed one')
		.option('--allow-unpublished', 'Approve a helper this node version does not publish (a build of your own)')
		.option(
			'--signed',
			'Approve it by its code signature (macOS Developer ID / Windows Authenticode of the publisher this node version names): updates keep the approval'
		)
		.action(async (options: { path?: string; allowUnpublished?: boolean; signed?: boolean }) => {
			if (options.signed) {
				await runHelperCommand(deps, (helperDeps) =>
					helperAdmitSigned(helperDeps, options.path ? { path: options.path } : {})
				);
				return;
			}
			await runHelperCommand(deps, (helperDeps) => helperAdmit(helperDeps, options));
		});
	helper
		.command('revoke')
		.description('Withdraw the approval: a running node stops the helper and ends every desktop view')
		.action(async () => {
			await runHelperCommand(deps, (helperDeps) => helperRevoke(helperDeps));
		});
	helper
		.command('status')
		.description('Show whether the screen helper is installed, approved and unchanged')
		.option('--json', 'Emit the report as one JSON object')
		.action(async (options: { json?: boolean }) => {
			await runHelperCommand(deps, (helperDeps) => helperStatus(helperDeps, options));
		});
	// FL-07 P2: the owner's permission, on this machine, for people to take control of
	// its mouse and keyboard from a live view (default: not allowed).
	const helperControl = helper
		.command('control')
		.description(
			'Allow or withdraw control of this computer’s mouse and keyboard from a live view (default: not allowed)'
		);
	helperControl
		.command('allow')
		.description('Let the people you allow take control of this computer from a live view (type "control")')
		.action(async () => {
			await runHelperCommand(deps, (helperDeps) => helperControlAllow(helperDeps));
		});
	helperControl
		.command('deny')
		.description('Withdraw control: a running node lets go of every key and button and ends any control at once')
		.action(async () => {
			await runHelperCommand(deps, (helperDeps) => helperControlDeny(helperDeps));
		});
	helperControl
		.command('status')
		.description('Show whether control of this computer is allowed')
		.option('--json', 'Emit the report as one JSON object')
		.action(async (options: { json?: boolean }) => {
			await runHelperCommand(deps, (helperDeps) => helperControlStatus(helperDeps, options));
		});

	// Schedules on computers (FL-13 P3): what the OS scheduler starts. Hidden.
	program
		.command('schedule-run', { hidden: true })
		.description(
			"Run what is due of this computer's schedules once (started by the OS scheduler; not for direct use)"
		)
		.argument('<id>', 'The schedule the OS scheduler fired')
		.action(async (id: string) => {
			await runScheduleRun(deps, id);
		});

	// Sessions on computers (FL-04): the session daemon's own entry. Hidden —
	// the node starts it, a person never does (README D3: one installable).
	program
		.command('session-daemon', { hidden: true })
		.description('Run the session daemon (started by the node; not for direct use)')
		.requiredOption('--state-dir <dir>', 'The daemon state directory')
		.requiredOption('--socket <path>', 'The local socket or named pipe to listen on')
		.requiredOption('--token-file <file>', 'The token file that guards the socket')
		.action(async (options: SessionDaemonCommandOptions) => {
			await runSessionDaemonCommand(deps, options);
		});

	return program;
}

interface SessionDaemonCommandOptions {
	stateDir: string;
	socket: string;
	tokenFile: string;
}

/**
 * `ever-works-node session-daemon` (hidden). Starts listening and returns;
 * the listening socket keeps the process alive until the daemon's idle rule
 * (no session, no node, five minutes) or a system shutdown ends it.
 */
export async function runSessionDaemonCommand(deps: CliDeps, options: SessionDaemonCommandOptions): Promise<void> {
	const join = deps.platform === 'win32' ? win32.join : posix.join;
	const logFile = join(options.stateDir, 'daemon.log');
	const run = deps.runSessionDaemon ?? runSessionDaemon;
	let daemon: Awaited<ReturnType<typeof runSessionDaemon>>;
	try {
		daemon = await run({
			stateDir: options.stateDir,
			socketPath: options.socket,
			tokenFile: options.tokenFile,
			logFile,
			version: deps.io.version
		});
	} catch (error) {
		throw new CliError(
			`The session daemon could not start: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!deps.runSessionDaemon) installDaemonProcessHandlers(daemon, logFile);
}

/**
 * The session daemon as `doctor` reports it — read-only: it never creates a
 * token and never starts a daemon.
 */
export async function describeSessionDaemon(
	deps: CliDeps
): Promise<{ daemon: 'running' | 'not-running'; pty?: 'available' | 'missing'; sessions?: number; reason?: string }> {
	const paths = resolveSessionDaemonPaths({ configPath: deps.configPath, platform: deps.platform, env: process.env });
	let token: string | null = null;
	try {
		token = (await deps.fs.readFile(paths.tokenFile))?.trim() ?? null;
	} catch {
		token = null;
	}
	if (!token) return { daemon: 'not-running', reason: 'no session daemon has been started on this computer' };
	try {
		const client = await DaemonControlClient.connect({ socketPath: paths.socketPath, token, timeoutMs: 2_000 });
		const health = client.welcome;
		client.close();
		return {
			daemon: 'running',
			pty: health.pty,
			sessions: health.sessions,
			...(health.ptyReason ? { reason: health.ptyReason } : {})
		};
	} catch {
		return { daemon: 'not-running', reason: 'the session daemon did not answer on its local socket' };
	}
}

/**
 * Parse `argv` (user-style, without node/script) and run. Returns the process
 * exit code instead of calling `process.exit`, so it is safe to await in tests.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const program = buildProgram(deps);
	try {
		await program.parseAsync(argv, { from: 'user' });
		return EXIT_OK;
	} catch (error) {
		if (error instanceof CommanderError) {
			// `--help` / `--version` are successful terminations, not failures.
			return error.exitCode === 0 ? EXIT_OK : EXIT_FAILURE;
		}
		if (error instanceof CliError) {
			deps.io.logger.error(error.message);
			return error.exitCode;
		}
		if (error instanceof FleetClientError) {
			deps.io.logger.error(`${error.message} [${error.kind}]`);
			return EXIT_FAILURE;
		}
		const message = error instanceof Error ? error.message : String(error);
		deps.io.logger.error(deps.io.logger.redact(message));
		return EXIT_FAILURE;
	}
}

/** The screen helper's admission deps for this CLI (FL-07). */
export function helperAdmissionDeps(deps: CliDeps): HelperAdmissionDeps {
	const arch = deps.arch ?? deps.io.environment.arch;
	// P3: the OS signature check (macOS, Windows), bound to the signer this node version publishes.
	const checkSignature = nodeHelperSignatureChecker(deps.io.runner, deps.platform, arch, BAKED_HELPER_MANIFEST);
	return {
		fs:
			deps.helperFs ??
			createHelperFs({ platform: deps.platform, ...(deps.restrictFile ? { restrict: deps.restrictFile } : {}) }),
		paths: helperPathsFor(deps.configPath, deps.platform),
		platform: deps.platform,
		arch,
		manifest: BAKED_HELPER_MANIFEST,
		hostName: safeHostname(),
		out: deps.out,
		...(deps.readLine ? { readLine: deps.readLine } : {}),
		...(deps.helperFetch ? { fetchFn: deps.helperFetch } : {}),
		...(deps.now ? { now: deps.now } : {}),
		...(checkSignature ? { checkSignature } : {})
	};
}

function safeHostname(): string {
	try {
		return osHostname() || 'this computer';
	} catch {
		return 'this computer';
	}
}

/** Run one `helper …` verb, turning its refusal into the CLI's own error. */
async function runHelperCommand(
	deps: CliDeps,
	run: (helperDeps: HelperAdmissionDeps) => Promise<unknown>
): Promise<void> {
	try {
		await run(helperAdmissionDeps(deps));
	} catch (error) {
		if (error instanceof HelperAdmissionError) throw new CliError(error.message, error.exitCode);
		throw error;
	}
}

/** `<configDir>/schedules` — where `start` keeps the schedules (FL-13). */
function scheduleDirFor(deps: CliDeps): string {
	const paths = deps.platform === 'win32' ? win32 : posix;
	return paths.join(paths.dirname(deps.configPath), 'schedules');
}

/**
 * `ever-works-node schedule-run <id>` (hidden; FL-13 P3) — what the OS
 * scheduler starts at a fire. When a node process holds the schedule loop
 * (its lease is fresh) this does nothing: that loop runs the fire on its own
 * clock. Otherwise it loads the held schedules, runs whatever is due (the
 * same catch-up rule as the loop: within the 60-minute grace, at most once
 * per fire, one at a time per schedule), waits for the runs to end and exits.
 * The runs are kept in the history and reported on the next link.
 */
export async function runScheduleRun(deps: CliDeps, id: string): Promise<void> {
	const dir = scheduleDirFor(deps);
	const store = new ScheduleStore({ dir });
	if (await store.isLoopAlive(Date.now())) {
		deps.out(`The node is running; its own clock runs schedule ${id}.`);
		return;
	}
	let nodeName = 'this computer';
	try {
		const config = await requireConfig(deps);
		nodeName = config.name?.trim() || nodeName;
	} catch {
		// A schedule still runs on a machine whose config cannot be read now.
	}
	const loop = new ScheduleLoop({
		store,
		history: new ScheduleHistory({ dir }),
		nodeName,
		platform: deps.platform,
		homedir: osHomedir(),
		env: process.env,
		timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
		logger: deps.io.logger,
		lease: false
	});
	await loop.start();
	await loop.idle();
	loop.dispose();
}

/** Remove every OS-scheduler entry the fallback wrote (best-effort; `unenroll`). */
async function removeNativeSchedules(deps: CliDeps): Promise<void> {
	try {
		await createNativeScheduler({
			platform: deps.platform,
			homedir: osHomedir(),
			command: { file: '', args: [] }
		})?.remove();
	} catch (error) {
		deps.io.logger.warn(
			`Could not remove the OS-scheduler entries of this node's schedules: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

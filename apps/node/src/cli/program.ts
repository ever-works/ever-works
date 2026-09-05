import { Command, CommanderError } from 'commander';
import { posix, win32 } from 'node:path';
import { describeSelf } from '../core/capabilities';
import { clearConfig, loadConfig, saveConfig, type ConfigFileSystem } from '../core/config-store';
import { resolveModelCliPaths } from '../core/model-cli-probe';
import { FleetClientError } from '../core/fleet-client';
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
	type NodeConfig,
	type NodeResourceLimits,
	type NodeWorkspaceGcPolicy
} from '../core/types';

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
 *   doctor       disk headroom vs the floor, and what the workspace reaper would do
 *   gc           run the workspace reaper (age / LRU, fail-closed; --dry-run to look)
 *
 * Built as `buildProgram(deps)` over injected IO so argument parsing and every
 * command body are unit-testable without a network, a disk or a real process.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
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
	token: string;
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

export async function runEnroll(deps: CliDeps, options: EnrollCommandOptions): Promise<void> {
	const heartbeatIntervalMs = parseIntervalSeconds(options.heartbeatInterval);
	const capabilitySelection = parseCapabilityList(options.capabilities);
	const limits = parseLimitFlags(options);
	const workspaceGc = parseWorkspaceGcFlags(options);
	const config = await enrollNode({
		...deps.io,
		apiUrl: options.apiUrl,
		token: options.token,
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
	if (workspaceGcOverrides !== undefined || rootChanged) {
		await saveConfig(
			deps.fs,
			deps.configPath,
			{ ...stored, workspaceGc, ...(workspaceRoot !== undefined ? { workspaceRoot } : {}) },
			{ platform: deps.platform, secrets: deps.secrets ?? null, logger: deps.io.logger }
		);
	}
	const config: NodeConfig = {
		...stored,
		workspaceGc,
		...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
		...(override === undefined ? {} : { heartbeatIntervalMs: override })
	};

	const workerEnabled = options.work === true;
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
			? resolveModelCliPaths(
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
				)
			: { paths: deps.io.environment.modelCli ?? {}, notes: deps.io.environment.modelCliNotes ?? [] };
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
		environment: { ...deps.io.environment, modelCli: modelCli.paths, modelCliNotes: modelCli.notes }
	};
	const runtime = createNodeRuntime(config, io, {
		workerEnabled,
		startPaused,
		limits: effectiveLimits,
		modelCli: modelCli.paths,
		// Written directly (not via a conditional spread) so excess-property
		// checking keeps this name tied to the runtime option it feeds.
		agentTaskWorkspaceRoot: workspaceRoot,
		persistUnsafe: async (unsafe) =>
			saveConfig(
				deps.fs,
				deps.configPath,
				{ ...config, unsafe },
				{
					platform: deps.platform,
					secrets: deps.secrets ?? null,
					logger: deps.io.logger
				}
			),
		workerSafetyGate: createConfigWorkerSafetyGate(deps.fs, deps.configPath, { platform: deps.platform }),
		...(deps.resourceProbe ? { resourceProbe: deps.resourceProbe } : {})
	});
	const { loop, worker } = runtime;
	loop.onChange((state) => {
		if (state.state === 'connected') {
			deps.io.logger.info(`Heartbeat accepted — node ${config.nodeId} is online`);
		}
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
	if (worker) {
		await worker.start();
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

	// Block until shutdown is requested: the injected hook (tests) or a signal
	// (the real service). With neither wired there is nothing that could ever
	// wake us, so fall straight through instead of hanging forever.
	await (deps.waitForShutdown?.() ?? (deps.signals ? signalled : Promise.resolve()));

	reaper?.stop();
	loop.stop();
	await loop.settled();
	if (worker) {
		// Drains: stops leasing at once, then WAITS for the jobs already
		// running so their verdicts reach the platform instead of being
		// abandoned to a lease expiry and re-run somewhere else.
		await worker.stop();
		const state = worker.getState();
		deps.out(`Worker host stopped (completed ${state.completed}, failed ${state.failed}).`);
	}
	deps.out('Stopped.');
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

export async function runStatus(deps: CliDeps): Promise<void> {
	const config = await requireConfig(deps);
	const view = redactConfig(config);
	deps.out(`node id      ${view.nodeId}`);
	deps.out(`name         ${view.name ?? '(assigned by the platform)'}`);
	deps.out(`kind         ${view.kind}`);
	deps.out(`api          ${view.apiUrl}`);
	deps.out(`enrolled at  ${view.enrolledAt}`);
	deps.out(`heartbeat    every ${view.heartbeatIntervalMs / 1000}s`);
	deps.out(`capabilities ${view.capabilities.join(', ') || '(none)'}`);
	// The secret itself is never printed — only whether one is stored,
	// and where. Naming the location is what makes a silent downgrade to
	// plaintext visible.
	deps.out(`credential   ${view.hasSecret ? 'stored' : 'MISSING'} (${view.secretStorage})`);
	deps.out(`work         ${view.paused ? 'PAUSED (draining — no new work)' : 'accepting new work'}`);
	deps.out(
		`offering     ${view.capabilitySelection ? view.capabilitySelection.join(', ') || '(identity only)' : '(everything detected)'}`
	);
	deps.out(`limits       ${describeLimits(view.limits)}`);
	deps.out(`workspace gc ${describeWorkspaceGc(view.workspaceGc ?? DEFAULT_WORKSPACE_GC_POLICY)}`);
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

/** `doctor`: read-only. Exit 0 even when below the floor — the finding IS the output. */
export async function runDoctor(deps: CliDeps, options: DoctorCommandOptions): Promise<void> {
	const report = await gatherHousekeeping(deps, options);
	const now = (deps.now ?? (() => Date.now()))();
	if (options.json === true) {
		deps.out(JSON.stringify(housekeepingJson(report), null, 2));
		return;
	}
	printHousekeepingHeader(deps, report, now);
	printPlan(deps, report.plan, now);
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
		.requiredOption('-t, --token <token>', 'One-time enrollment token (single-use, expires in 15 minutes)')
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

	return program;
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

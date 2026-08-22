import { Command, CommanderError } from 'commander';
import { describeSelf } from '../core/capabilities';
import { clearConfig, loadConfig, saveConfig, type ConfigFileSystem } from '../core/config-store';
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
import type { ResourceProbe } from '../core/resource-limits';
import {
	clampResourceLimits,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_CONCURRENT_JOBS,
	MAX_CPU_PERCENT,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_CONCURRENT_JOBS,
	MIN_CPU_PERCENT,
	MIN_HEARTBEAT_INTERVAL_MS,
	MIN_MEMORY_MB,
	redactConfig,
	type NodeConfig,
	type NodeResourceLimits
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

/** Build the resource-limit overrides implied by the CLI flags, if any. */
export function parseLimitFlags(options: {
	concurrency?: string;
	maxCpu?: string;
	maxMemory?: string;
}): Partial<NodeResourceLimits> | undefined {
	const maxConcurrentJobs = parseBounded(
		options.concurrency,
		'--concurrency',
		MIN_CONCURRENT_JOBS,
		MAX_CONCURRENT_JOBS
	);
	const maxCpuPercent = parseBounded(options.maxCpu, '--max-cpu', MIN_CPU_PERCENT, MAX_CPU_PERCENT);
	const maxMemoryMb = parseBounded(options.maxMemory, '--max-memory', MIN_MEMORY_MB, Number.MAX_SAFE_INTEGER);

	const limits: Partial<NodeResourceLimits> = {};
	if (maxConcurrentJobs !== undefined) limits.maxConcurrentJobs = maxConcurrentJobs;
	if (maxCpuPercent !== undefined) limits.maxCpuPercent = maxCpuPercent;
	if (maxMemoryMb !== undefined) limits.maxMemoryMb = maxMemoryMb;
	return Object.keys(limits).length > 0 ? limits : undefined;
}

function describeLimits(limits: NodeResourceLimits): string {
	const parts = [`${limits.maxConcurrentJobs} concurrent job(s)`];
	parts.push(limits.maxCpuPercent === null ? 'no CPU ceiling' : `CPU < ${limits.maxCpuPercent}%`);
	parts.push(limits.maxMemoryMb === null ? 'no memory ceiling' : `memory < ${limits.maxMemoryMb}MB`);
	return parts.join(', ');
}

export async function runEnroll(deps: CliDeps, options: EnrollCommandOptions): Promise<void> {
	const heartbeatIntervalMs = parseIntervalSeconds(options.heartbeatInterval);
	const capabilitySelection = parseCapabilityList(options.capabilities);
	const limits = parseLimitFlags(options);
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
}

export async function runStart(deps: CliDeps, options: StartCommandOptions): Promise<void> {
	const override = parseIntervalSeconds(options.heartbeatInterval);
	const stored = await requireConfig(deps);
	const config: NodeConfig = override === undefined ? stored : { ...stored, heartbeatIntervalMs: override };

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
	const { loop, worker } = createNodeRuntime(config, deps.io, {
		workerEnabled,
		startPaused,
		limits: effectiveLimits,
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
		...(deps.resourceProbe ? { resourceProbe: deps.resourceProbe } : {})
	});
	loop.onChange((state) => {
		if (state.state === 'connected') {
			deps.io.logger.info(`Heartbeat accepted — node ${config.nodeId} is online`);
		}
	});

	deps.out(`Starting node ${config.nodeId} → ${config.apiUrl} (every ${config.heartbeatIntervalMs / 1000}s)`);
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
	} else {
		// Say so explicitly: an operator who expected this machine to run
		// work should not have to infer it from an absence of log lines.
		deps.out('Worker host disabled — reporting liveness only (pass --work to execute platform work)');
	}

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

	// Block until shutdown is requested: the injected hook (tests) or a signal
	// (the real service). With neither wired there is nothing that could ever
	// wake us, so fall straight through instead of hanging forever.
	await (deps.waitForShutdown?.() ?? (deps.signals ? signalled : Promise.resolve()));

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
	if (!config.unsafe) {
		deps.out('No worker quarantine is recorded.');
		return;
	}
	if (options.confirmProcessTreeStopped !== true) {
		throw new CliError(
			'Refusing to clear quarantine without --confirm-process-tree-stopped. Verify the prior Git/command process tree is no longer running first.'
		);
	}
	const cleared = { ...config };
	delete cleared.unsafe;
	await saveConfig(deps.fs, deps.configPath, cleared, {
		platform: deps.platform,
		secrets: deps.secrets ?? null,
		logger: deps.io.logger
	});
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
	// The secret itself is never printed — only whether one is stored.
	deps.out(`credential   ${view.hasSecret ? 'stored' : 'MISSING'}`);
	deps.out(`config       ${deps.configPath}`);
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

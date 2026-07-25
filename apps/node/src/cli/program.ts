import { Command, CommanderError } from 'commander';
import { describeSelf } from '../core/capabilities';
import { loadConfig, saveConfig, type ConfigFileSystem } from '../core/config-store';
import { FleetClientError } from '../core/fleet-client';
import {
	createNodeRuntime,
	enrollNode,
	installShutdownHandlers,
	type NodeIo,
	type SignalSource
} from '../core/runtime';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	redactConfig,
	type NodeConfig
} from '../core/types';

/**
 * `ever-works-node` CLI.
 *
 * Verbs (PRD §3.3):
 *   enroll       consume a one-time token and persist the node credential
 *   start        run the heartbeat loop until SIGINT/SIGTERM
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
	/** `process.platform`; drives the 0600 chmod decision. */
	platform: string;
	/** User-facing output (stdout). Separate from the logger's diagnostic stream. */
	out(line: string): void;
	signals?: SignalSource;
	/**
	 * Blocks until the node should shut down. Defaults to "never resolves"
	 * (the real service runs until a signal arrives); tests override it.
	 */
	waitForShutdown?(): Promise<void>;
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

async function requireConfig(deps: CliDeps): Promise<NodeConfig> {
	const config = await loadConfig(deps.fs, deps.configPath);
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
}

export async function runEnroll(deps: CliDeps, options: EnrollCommandOptions): Promise<void> {
	const heartbeatIntervalMs = parseIntervalSeconds(options.heartbeatInterval);
	const config = await enrollNode({
		...deps.io,
		apiUrl: options.apiUrl,
		token: options.token,
		kind: 'node',
		...(options.name !== undefined ? { name: options.name } : {}),
		...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {})
	});

	await saveConfig(deps.fs, deps.configPath, config, { platform: deps.platform });

	deps.out(`Enrolled as node ${config.nodeId}`);
	deps.out(`  name         ${config.name ?? '(assigned by the platform)'}`);
	deps.out(`  api          ${config.apiUrl}`);
	deps.out(`  capabilities ${config.capabilities.join(', ') || '(none detected)'}`);
	deps.out(`  config       ${deps.configPath}`);
	deps.out('');
	deps.out('Run `ever-works-node start` to begin heartbeating.');
}

export interface StartCommandOptions {
	heartbeatInterval?: string;
}

export async function runStart(deps: CliDeps, options: StartCommandOptions): Promise<void> {
	const override = parseIntervalSeconds(options.heartbeatInterval);
	const stored = await requireConfig(deps);
	const config: NodeConfig = override === undefined ? stored : { ...stored, heartbeatIntervalMs: override };

	const { loop } = createNodeRuntime(config, deps.io);
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
			deps.io.logger.info('Shutdown signal received — stopping heartbeat');
			requestShutdown();
		});
	}

	await loop.start();

	// Block until shutdown is requested: the injected hook (tests) or a signal
	// (the real service). With neither wired there is nothing that could ever
	// wake us, so fall straight through instead of hanging forever.
	await (deps.waitForShutdown?.() ?? (deps.signals ? signalled : Promise.resolve()));

	loop.stop();
	await loop.settled();
	deps.out('Stopped.');
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
	// The secret itself is never printed — only whether one is stored.
	deps.out(`credential   ${view.hasSecret ? 'stored' : 'MISSING'}`);
	deps.out(`config       ${deps.configPath}`);
}

export async function runCapabilities(deps: CliDeps): Promise<void> {
	const description = await describeSelf(deps.io.runner, deps.io.environment, deps.io.version);
	deps.out(`platform     ${description.platform}`);
	deps.out(`version      ${description.version}`);
	deps.out(`capabilities ${description.capabilities.join(', ')}`);
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
		.action(async (options: EnrollCommandOptions) => {
			await runEnroll(deps, options);
		});

	program
		.command('start')
		.description('Run the heartbeat loop until SIGINT/SIGTERM')
		.option('-i, --heartbeat-interval <seconds>', 'Override the stored heartbeat cadence, in seconds')
		.action(async (options: StartCommandOptions) => {
			await runStart(deps, options);
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

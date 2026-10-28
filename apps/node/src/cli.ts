#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runCli, type CliDeps } from './cli/program';
import { createLogger } from './core/logger';
import {
	createCommandRunner,
	createConfigFileSystem,
	createDiskProbe,
	createHealthProbeIo,
	createSecretStore,
	createWakeSender,
	createResourceProbe,
	defaultConfigPath,
	isExecutableFile,
	probeEnvironment,
	readNetworkInterfaces,
	resolveEntryPath,
	restrictFileToOwnerWindows,
	statModelCliFile,
	systemFetch
} from './node-io';
import { NODE_APP_VERSION } from './version';

/**
 * `ever-works-node` executable entry point.
 *
 * Nothing but IO binding lives here — every decision is in `cli/program.ts`,
 * which is driven by fakes in the test suite.
 */

async function buildDeps(): Promise<CliDeps> {
	const logger = createLogger();
	const runner = createCommandRunner();
	// Boot-probe retry: each retry of a timed-out boot probe is said on STDERR. The PATH
	// lookups run before any command does, so on a busy machine a `--json`
	// command's stdout must not start with a warning; the outcome itself (a
	// "probe timed out" note, a quarantine reason) still goes through `logger`.
	const bootProbeLogger = createLogger({
		sink: (entry) =>
			process.stderr.write(
				`[${new Date(entry.at).toISOString()}] ${entry.level.toUpperCase()} ${entry.message}\n`
			)
	});
	// Boot-probe retry: the model-CLI PATH lookups retry while a busy machine times them
	// out, and one that timed out on every attempt is reported as such rather
	// than as "not found on PATH".
	const environment = await probeEnvironment({ runner, logger: bootProbeLogger });
	return {
		io: {
			fetchFn: systemFetch,
			runner,
			environment,
			logger,
			version: NODE_APP_VERSION,
			userAgent: `ever-works-node/${NODE_APP_VERSION}`,
			// Backs the free-disk figure in the Fleet runner indicator.
			// Optional by contract — an unreadable volume reports nothing
			// rather than failing the heartbeat that carries everything else.
			diskProbe: createDiskProbe(),
			// Node lifecycle (slice AR): the cache key of the model-CLI
			// compatibility probe, so an upgraded CLI is re-probed at once.
			statFile: statModelCliFile,
			// Computer health (FL-03): the snapshot every heartbeat carries.
			health: createHealthProbeIo(runner),
			// Computer health, second phase (FL-03): the primary interface for
			// Wake-on-LAN (read under `--manage` only) and the packet sender.
			network: readNetworkInterfaces,
			wakeSender: createWakeSender()
		},
		// Boot-probe retry: the owner-only ACL (the worker-safety marker's boot-time proof,
		// the config file's tightening) retries a timed-out `icacls`, and says so.
		fs: createConfigFileSystem({ runner, logger: bootProbeLogger }),
		configPath: defaultConfigPath(),
		platform: process.platform,
		// Null when this host has no keychain — `resolveSecretStore`
		// warns on that path rather than downgrading in silence.
		secrets: createSecretStore(logger),
		// Backs the CPU/memory admission gate. Harmless when no ceilings are
		// configured — the worker loop skips sampling entirely in that case.
		resourceProbe: createResourceProbe(),
		// Validates `--claude-path` / `--codex-path` pins before a job can
		// ever try to spawn them.
		fileExists: isExecutableFile,
		out: (line) => process.stdout.write(`${line}\n`),
		signals: {
			on: (signal, handler) => {
				process.on(signal, handler);
			}
		},
		// Sessions on computers (FL-04): the session daemon is this same CLI
		// (a hidden subcommand), run by the same Node binary.
		...(process.argv[1] ? { sessionDaemonCommand: { command: process.execPath, args: [process.argv[1]] } } : {}),
		...(process.platform === 'win32' ? { restrictFile: (file: string) => restrictFileToOwnerWindows(file) } : {}),
		// Fleet node link (FL-02 T-25): what `--auto-update` identifies the install by.
		entryPath: resolveEntryPath(),
		// Desktop view & control (FL-07): `helper admit` reads the typed word from
		// a person at this keyboard — only when stdin IS a terminal.
		arch: process.arch,
		...(process.stdin.isTTY ? { readLine: readTypedLine } : {})
	};
}

/** One line typed at the terminal (FL-07 `helper admit`). */
async function readTypedLine(prompt: string): Promise<string | null> {
	const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		return await terminal.question(prompt);
	} catch {
		return null;
	} finally {
		terminal.close();
	}
}

async function main(): Promise<void> {
	const code = await runCli(process.argv.slice(2), await buildDeps());
	process.exitCode = code;
}

if (require.main === module) {
	void main();
}

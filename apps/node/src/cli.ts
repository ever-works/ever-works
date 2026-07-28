#!/usr/bin/env node
import { runCli, type CliDeps } from './cli/program';
import { createLogger } from './core/logger';
import {
	createCommandRunner,
	createConfigFileSystem,
	createSecretStore,
	createResourceProbe,
	currentEnvironment,
	defaultConfigPath,
	systemFetch
} from './node-io';
import { NODE_APP_VERSION } from './version';

/**
 * `ever-works-node` executable entry point.
 *
 * Nothing but IO binding lives here — every decision is in `cli/program.ts`,
 * which is driven by fakes in the test suite.
 */

function buildDeps(): CliDeps {
	const logger = createLogger();
	return {
		io: {
			fetchFn: systemFetch,
			runner: createCommandRunner(),
			environment: currentEnvironment(),
			logger,
			version: NODE_APP_VERSION,
			userAgent: `ever-works-node/${NODE_APP_VERSION}`
		},
		fs: createConfigFileSystem(),
		configPath: defaultConfigPath(),
		platform: process.platform,
		// Null when this host has no keychain — `resolveSecretStore`
		// warns on that path rather than downgrading in silence.
		secrets: createSecretStore(logger),
		// Backs the CPU/memory admission gate. Harmless when no ceilings are
		// configured — the worker loop skips sampling entirely in that case.
		resourceProbe: createResourceProbe(),
		out: (line) => process.stdout.write(`${line}\n`),
		signals: {
			on: (signal, handler) => {
				process.on(signal, handler);
			}
		}
	};
}

async function main(): Promise<void> {
	const code = await runCli(process.argv.slice(2), buildDeps());
	process.exitCode = code;
}

if (require.main === module) {
	void main();
}

import { spawnSync } from 'child_process';
import type { HermesRuntimeSettings } from './pipeline-helpers.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
}

export async function ensureBinary(
	settings: HermesRuntimeSettings,
	logger: Logger
): Promise<string> {
	const binaryPath = settings.binaryPath || 'hermes';

	const result = spawnSync(binaryPath, ['--version'], {
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe']
	});

	if (result.error || result.status !== 0) {
		throw new Error(
			`Hermes CLI was not found or is not runnable at "${binaryPath}". Install Hermes Agent on the backend machine or configure binaryPath in the plugin settings.`
		);
	}

	logger.log(`Using Hermes CLI from "${binaryPath}"`);
	return binaryPath;
}

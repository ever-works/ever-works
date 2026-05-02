import { spawn } from 'child_process';
import type { HermesRuntimeSettings } from './pipeline-helpers.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

async function runCommand(binaryPath: string, args: string[]): Promise<CommandResult> {
	return new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(binaryPath, args, {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf-8');
		});

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});

		child.on('error', reject);
		child.on('exit', (status) => {
			resolve({
				stdout,
				stderr,
				status
			});
		});
	});
}

export async function ensureBinary(settings: HermesRuntimeSettings, logger: Logger): Promise<string> {
	const binaryPath = settings.binaryPath || 'hermes';
	const result = await runCommand(binaryPath, ['--version']);

	if (result.status !== 0) {
		throw new Error(
			`Hermes CLI was not found or is not runnable at "${binaryPath}". Install Hermes Agent on the backend machine or configure binaryPath in the plugin settings.`
		);
	}

	logger.log(`Using Hermes CLI from "${binaryPath}"`);
	return binaryPath;
}

export async function validateProfile(settings: HermesRuntimeSettings, logger: Logger): Promise<void> {
	const binaryPath = await ensureBinary(settings, logger);
	const profile = settings.profile || 'default';
	const result = await runCommand(binaryPath, ['profile', 'show', profile]);

	if (result.status !== 0) {
		const detail = [result.stderr, result.stdout].map((value) => value.trim()).find((value) => Boolean(value));
		const suffix = detail ? ` Hermes output: ${detail}` : '';

		throw new Error(
			`Hermes profile "${profile}" is not available or not configured correctly on the backend machine.${suffix}`
		);
	}

	logger.log(`Validated Hermes profile "${profile}"`);
}

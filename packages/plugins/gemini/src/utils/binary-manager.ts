import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { BASE_TEMP_DIR, DEFAULT_CLI_VERSION, GEMINI_NPM_PACKAGE } from '../types.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'ignore', 'pipe'],
			env: process.env
		});

		let stderr = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});

		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
		});
	});
}

export function getBinaryPath(version: string): string {
	return path.join(BASE_TEMP_DIR, 'bin', `gemini-${version}`, 'node_modules', '.bin', 'gemini');
}

/**
 * Ensure the Gemini CLI package is installed into a cached prefix directory.
 */
export async function ensureBinary(version: string = DEFAULT_CLI_VERSION, logger?: Logger): Promise<string> {
	const installDir = path.join(BASE_TEMP_DIR, 'bin', `gemini-${version}`);
	const binaryPath = getBinaryPath(version);

	try {
		await fs.access(binaryPath, fs.constants.X_OK);
		logger?.debug(`Gemini CLI already cached at ${binaryPath}`);
		return binaryPath;
	} catch {
		// continue with install
	}

	await fs.mkdir(installDir, { recursive: true });
	await fs.writeFile(
		path.join(installDir, 'package.json'),
		JSON.stringify({ private: true, name: 'ever-works-gemini-runtime' }, null, 2),
		'utf-8'
	);

	const packageSpec = version === 'latest' ? GEMINI_NPM_PACKAGE : `${GEMINI_NPM_PACKAGE}@${version}`;

	logger?.log(`Installing Gemini CLI (${packageSpec})...`);
	await runCommand('npm', ['install', '--no-package-lock', '--silent', packageSpec], installDir);

	await fs.access(binaryPath, fs.constants.X_OK);
	logger?.log(`Gemini CLI ready at ${binaryPath}`);
	return binaryPath;
}

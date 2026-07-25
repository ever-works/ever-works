import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandRunner } from './core/capabilities';
import { readEnvironment, type CapabilityEnvironment } from './core/capabilities';
import { resolveConfigPath, type ConfigFileSystem } from './core/config-store';
import type { FetchLike } from './core/fleet-client';

/**
 * Real IO adapters for the headless node.
 *
 * Everything the core consumes is an interface; this module is the one place
 * that binds those interfaces to Node built-ins. Tests never import it.
 */

/** `execFile`-backed runner, matching `apps/desktop`'s command-runner shape. */
export function createCommandRunner(): CommandRunner {
	return {
		run: (command, args) =>
			new Promise((resolve) => {
				execFile(
					command,
					args,
					{ shell: process.platform === 'win32', windowsHide: true, timeout: 10_000 },
					(error, stdout, stderr) => {
						const code = error
							? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1)
							: 0;
						resolve({
							code: typeof code === 'number' ? code : 1,
							stdout: String(stdout),
							stderr: String(stderr)
						});
					}
				);
			})
	};
}

export function createConfigFileSystem(): ConfigFileSystem {
	return {
		readFile: async (filePath) => {
			try {
				return await fsp.readFile(filePath, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return null;
				}
				throw error;
			}
		},
		writeFile: async (filePath, content) => {
			// Create with 0600 from the start so the secret is never briefly
			// world-readable between write and chmod.
			await fsp.writeFile(filePath, content, {
				encoding: 'utf8',
				mode: 0o600,
				flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
			});
		},
		mkdir: async (dirPath) => {
			await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
		},
		chmod: async (filePath, mode) => {
			await fsp.chmod(filePath, mode);
		},
		dirname: (filePath) => path.dirname(filePath)
	};
}

/** Default config-file location for this host (see `resolveConfigPath`). */
export function defaultConfigPath(): string {
	return resolveConfigPath({
		env: process.env,
		platform: process.platform,
		homedir: os.homedir(),
		join: path.join
	});
}

export function currentEnvironment(): CapabilityEnvironment {
	return readEnvironment({
		platform: process.platform,
		arch: process.arch,
		version: process.version,
		env: process.env
	});
}

/** Node 22 ships a global fetch; the core only needs `ok`/`status`/`text()`. */
export const systemFetch: FetchLike = (url, init) =>
	fetch(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		...(init.signal ? { signal: init.signal } : {})
	});

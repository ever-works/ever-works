import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBrowserPath } from './core/browser-probe';
import type { CommandRunner } from './core/capabilities';
import { readEnvironment, type CapabilityEnvironment } from './core/capabilities';
import { resolveConfigPath, type ConfigFileSystem } from './core/config-store';
import type { FetchLike } from './core/fleet-client';
import type { Logger } from './core/logger';
import { keychainDisabledByEnv, resolveSecretStore, type SecretStore } from './core/secret-store';
import type { ResourceProbe, ResourceSample } from './core/resource-limits';
import type { DiskProbeIo } from './core/telemetry-probe';

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

/**
 * Owner-only ACL for a file on Windows, via `icacls`.
 *
 * This is the win32 half of audit A45. Windows has no POSIX mode bits —
 * `fs.chmod` there only toggles the read-only flag — and the previous
 * behaviour was to skip the tightening entirely, leaving the node
 * credential protected by nothing but whatever the profile's inherited
 * ACL happened to admit.
 *
 * `/inheritance:r` strips inherited entries (this is what actually
 * removes broad access) and `/grant:r` then re-grants full control to
 * the current user alone.
 */
export function restrictFileToOwnerWindows(filePath: string): void {
	const user = process.env.USERDOMAIN
		? `${process.env.USERDOMAIN}\\${process.env.USERNAME ?? ''}`
		: (process.env.USERNAME ?? '');
	if (!user.trim() || user.trim() === '\\') {
		throw new Error('Cannot determine the current Windows user to grant the config file to');
	}
	execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`], {
		windowsHide: true,
		stdio: 'ignore',
		timeout: 10_000
	});
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
		createFileExclusive: async (filePath, content) => {
			await fsp.writeFile(filePath, content, {
				encoding: 'utf8',
				mode: 0o600,
				flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
			});
		},
		mkdir: async (dirPath) => {
			await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
		},
		chmod: async (filePath, mode) => {
			await fsp.chmod(filePath, mode);
		},
		remove: async (filePath) => {
			await fsp.rm(filePath, { force: true });
		},
		restrict: async (filePath) => {
			restrictFileToOwnerWindows(filePath);
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

/** True when the path is an existing file this process may execute. */
export function isExecutableFile(filePath: string): boolean {
	try {
		if (!existsSync(filePath)) {
			return false;
		}
		if (process.platform === 'win32') {
			// Windows has no execute bit; existence is the whole test.
			return true;
		}
		accessSync(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve a bare command name on `PATH`, or null. */
export function lookupOnPath(command: string): string | null {
	const which = process.platform === 'win32' ? 'where' : 'which';
	try {
		const output = execFileSync(which, [command], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5_000
		});
		const first = output.split(/\r?\n/).find((line) => line.trim());
		return first ? first.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Host facts for capability detection, including the browser executable
 * this machine would actually launch. Resolving it HERE (once, at
 * startup) rather than inside the detector keeps `detectCapabilities`
 * pure and keeps the `browser` tag and the `browser-check` executor
 * pointed at the same binary.
 */
export function currentEnvironment(): CapabilityEnvironment {
	return readEnvironment(
		{
			platform: process.platform,
			arch: process.arch,
			version: process.version,
			env: process.env
		},
		resolveBrowserPath,
		{ fileExists: isExecutableFile, lookupOnPath }
	);
}

/**
 * The OS keychain for this host, or null when there is none (headless
 * Linux without a Secret Service, containers, an operator opt-out).
 * A null return is always announced through the logger.
 */
export function createSecretStore(logger?: Logger): SecretStore | null {
	return resolveSecretStore({
		disabled: keychainDisabledByEnv(process.env),
		...(logger ? { logger } : {})
	});
}

const BYTES_PER_MB = 1024 * 1024;

/** Snapshot of cumulative per-core CPU time, in milliseconds. */
interface CpuTicks {
	idleMs: number;
	totalMs: number;
}

function readCpuTicks(): CpuTicks {
	let idleMs = 0;
	let totalMs = 0;
	for (const cpu of os.cpus()) {
		const times = cpu.times;
		idleMs += times.idle;
		totalMs += times.user + times.nice + times.sys + times.irq + times.idle;
	}
	return { idleMs, totalMs };
}

/**
 * Real host sampler for the CPU/memory admission gate.
 *
 * CPU has to be measured as a DELTA — `os.cpus()` reports cumulative ticks
 * since boot, so a single reading tells you the machine's lifetime average,
 * not what it is doing now. We keep the previous reading and diff against it;
 * the first call has no predecessor and reports 0%, which admits work. That is
 * the right bias: a node should not refuse its very first job because it has
 * not measured anything yet.
 *
 * `sampleWindowMs > 0` makes the first call take a real reading by waiting
 * that long between two snapshots; the default 0 keeps `sample()` synchronous
 * and relies on the delta between successive polls (which are seconds apart).
 */
export function createResourceProbe(options: { sampleWindowMs?: number } = {}): ResourceProbe {
	const windowMs = Math.max(options.sampleWindowMs ?? 0, 0);
	let previous: CpuTicks | null = null;

	const measure = (current: CpuTicks, baseline: CpuTicks | null): number => {
		if (!baseline) return 0;
		const totalDelta = current.totalMs - baseline.totalMs;
		const idleDelta = current.idleMs - baseline.idleMs;
		if (totalDelta <= 0) return 0;
		const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
		return Math.min(Math.max(busy, 0), 100);
	};

	return {
		sample: async (): Promise<ResourceSample> => {
			let baseline = previous;
			if (windowMs > 0) {
				baseline = readCpuTicks();
				await new Promise((resolve) => setTimeout(resolve, windowMs));
			}
			const current = readCpuTicks();
			const cpuPercent = measure(current, baseline);
			previous = current;

			const totalMemoryMb = os.totalmem() / BYTES_PER_MB;
			const freeMemoryMb = os.freemem() / BYTES_PER_MB;
			return {
				cpuPercent,
				usedMemoryMb: Math.max(totalMemoryMb - freeMemoryMb, 0),
				totalMemoryMb
			};
		}
	};
}

/**
 * Real free-disk probe for the runner-status telemetry.
 *
 * `fs.statfs` is the only cross-platform way to ask this from Node
 * without a native dependency, and it is not available on every runtime
 * / filesystem combination — so an unavailable API, an unmounted path or
 * a permission error all resolve to null rather than throwing. The
 * caller treats null as "unknown", and the platform treats an absent
 * field as "leave the stored reading alone", so a transient failure
 * never wipes a good one.
 *
 * `bavail` (blocks available to an UNPRIVILEGED process), not `bfree`:
 * the reserved-blocks difference is exactly the space a node's jobs
 * cannot actually use, and reporting it would overstate headroom on
 * every ext4 volume.
 */
export function createDiskProbe(): DiskProbeIo {
	return {
		freeBytes: async (targetPath: string): Promise<number | null> => {
			try {
				const stats = await fsp.statfs(targetPath);
				const available = Number(stats.bavail) * Number(stats.bsize);
				return Number.isFinite(available) && available >= 0 ? available : null;
			} catch {
				return null;
			}
		}
	};
}

/** Node 22 ships a global fetch; the core only needs `ok`/`status`/`text()`. */
export const systemFetch: FetchLike = (url, init) =>
	fetch(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		...(init.signal ? { signal: init.signal } : {})
	});

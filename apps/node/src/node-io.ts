import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
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
import { resolveModelCliPaths } from './core/model-cli-probe';
import type { ResourceProbe, ResourceSample } from './core/resource-limits';
import type { DiskProbeIo, DiskVolumeReading } from './core/telemetry-probe';
import type { HealthProbeIo } from './core/health-probe';

/**
 * Real IO adapters for the headless node.
 *
 * Everything the core consumes is an interface; this module is the one place
 * that binds those interfaces to Node built-ins. Tests never import it.
 */

/**
 * works-security finding 4 (node 0.2.7) — how a probe command is spawned.
 *
 * The capability / health probes name their tools bare (`powershell`,
 * `nvidia-smi`, `where`, `claude --version`). On Windows they used to run
 * through `cmd.exe` (`shell: true`) with the node's own working directory,
 * and `cmd.exe` looks in the CURRENT DIRECTORY before `PATH` — so a
 * `powershell.exe` or `nvidia-smi.exe` (or `.bat`/`.cmd`) sitting in
 * whatever directory the node happened to start in ran as the machine owner
 * on every heartbeat. Now:
 *
 *  - the Windows system tools resolve to their ABSOLUTE paths under
 *    `%SystemRoot%\System32` and start with `shell: false` — no `cmd.exe`,
 *    no search at all;
 *  - `nvidia-smi` resolves to the driver's known install locations
 *    (`System32` for DCH drivers, `NVSMI` for older ones); when none exists
 *    the probe reports "not installed" (`ENOENT`) without spawning anything;
 *  - everything else (the model CLIs' `.cmd` shims still need `cmd.exe`)
 *    runs with an explicit, owner-controlled `cwd` (`System32` on Windows,
 *    the home directory elsewhere) and `NoDefaultCurrentDirectoryInExePath`
 *    set, which tells `cmd.exe` (and libuv) not to search the current
 *    directory at all.
 */
export interface ProbeSpawnPlan {
	/** What to execute: an absolute path for the resolved tools, else the name as given. */
	file: string;
	shell: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface ProbeSpawnDeps {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists: (filePath: string) => boolean;
	homedir: () => string;
}

/** `C:\Windows`-shaped: a drive root plus plain segments, nothing relative or quoted. */
const WINDOWS_SYSTEM_ROOT = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)*)?\\?$/;

/** The Windows directory the system tools live under; `C:\Windows` when the environment is unusable. */
export function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
	for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR']) {
		const value = env[key];
		if (typeof value === 'string' && WINDOWS_SYSTEM_ROOT.test(value.trim())) {
			const trimmed = value.trim();
			// `C:\` stays `C:\` — stripping it to `C:` would make every join drive-RELATIVE.
			return trimmed.length > 3 ? trimmed.replace(/\\+$/, '') : trimmed;
		}
	}
	return 'C:\\Windows';
}

/** Bare names the node runs that are part of Windows itself, relative to `System32`. */
const WINDOWS_SYSTEM_TOOLS: Readonly<Record<string, readonly string[]>> = {
	powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
	where: ['where.exe'],
	icacls: ['icacls.exe']
};

/**
 * Plan one probe spawn — `null` when the tool is known not to be installed
 * (nothing is spawned and the caller reports `ENOENT`). Pure: every fact
 * comes from `deps`, so the plan is unit-testable on any OS.
 */
export function planProbeSpawn(command: string, deps: ProbeSpawnDeps): ProbeSpawnPlan | null {
	if (deps.platform !== 'win32') {
		let cwd = '/';
		try {
			cwd = deps.homedir() || '/';
		} catch {
			cwd = '/';
		}
		// execvp searches PATH only (never the current directory unless PATH
		// itself names it), so the name is kept and only the cwd is pinned.
		return { file: command, shell: false, cwd, env: deps.env };
	}
	const systemRoot = windowsSystemRoot(deps.env);
	const system32 = path.win32.join(systemRoot, 'System32');
	const env: NodeJS.ProcessEnv = { ...deps.env, NoDefaultCurrentDirectoryInExePath: '1' };
	const bare = path.win32.basename(command) === command ? command.toLowerCase().replace(/\.exe$/, '') : null;
	if (bare !== null) {
		const tool = WINDOWS_SYSTEM_TOOLS[bare];
		if (tool) return { file: path.win32.join(system32, ...tool), shell: false, cwd: system32, env };
		if (bare === 'nvidia-smi') {
			const candidates = [path.win32.join(system32, 'nvidia-smi.exe')];
			for (const key of ['ProgramW6432', 'ProgramFiles']) {
				const base = deps.env[key];
				if (typeof base === 'string' && WINDOWS_SYSTEM_ROOT.test(base.trim())) {
					candidates.push(path.win32.join(base.trim(), 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'));
				}
			}
			const found = candidates.find((candidate) => deps.exists(candidate));
			return found ? { file: found, shell: false, cwd: system32, env } : null;
		}
	}
	// The model CLIs (`claude.cmd`, `codex.cmd`), git, node … keep `cmd.exe` —
	// a `.cmd` shim cannot start without it — but never search the cwd.
	return { file: command, shell: true, cwd: system32, env };
}

function currentProbeSpawnDeps(): ProbeSpawnDeps {
	return { platform: process.platform, env: process.env, exists: existsSync, homedir: os.homedir };
}

/** `execFile`-backed runner, matching `apps/desktop`'s command-runner shape. */
export function createCommandRunner(): CommandRunner {
	return {
		run: (command, args, options) =>
			new Promise((resolve) => {
				const plan = planProbeSpawn(command, currentProbeSpawnDeps());
				if (!plan) {
					// Known not installed: report it exactly as a failed spawn would.
					resolve({ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT', timedOut: false });
					return;
				}
				// A caller's deadline (the health probe's per-fact budget) replaces
				// the default; anything that is not a positive finite number keeps it.
				const timeout =
					typeof options?.timeoutMs === 'number' &&
					Number.isFinite(options.timeoutMs) &&
					options.timeoutMs > 0
						? options.timeoutMs
						: 10_000;
				execFile(
					plan.file,
					args,
					{ shell: plan.shell, cwd: plan.cwd, env: plan.env, windowsHide: true, timeout },
					(error, stdout, stderr) => {
						const code = error
							? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1)
							: 0;
						resolve({
							code: typeof code === 'number' ? code : 1,
							stdout: String(stdout),
							stderr: String(stderr),
							// A string code is a spawn failure (`ENOENT`: not installed),
							// not an exit status; `code` above still reads 1 for callers
							// that only ask "did it succeed".
							...(typeof code === 'string' ? { spawnError: code } : {}),
							// `execFile` sets `killed` when it terminated the child at
							// `timeout`; what the child printed until then is partial.
							timedOut: Boolean(error && (error as { killed?: boolean }).killed)
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
	const icacls = planProbeSpawn('icacls', currentProbeSpawnDeps());
	execFileSync(icacls?.file ?? 'icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`], {
		windowsHide: true,
		stdio: 'ignore',
		timeout: 10_000,
		...(icacls ? { cwd: icacls.cwd, env: icacls.env } : {})
	});
}

/**
 * `icacls` arguments that make a directory owner-only on Windows: inherited
 * entries stripped, full control granted to `user` alone, and that grant
 * inherited by every file (`OI`) and subdirectory (`CI`) created inside it
 * later — a browser profile writes its cookies long after the directory
 * was made.
 */
export function windowsOwnerOnlyDirectoryAclArgs(dirPath: string, user: string): string[] {
	return [dirPath, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(F)`];
}

/**
 * Owner-only ACL for a directory on Windows (an Agent's profile: its browser
 * sessions and files). Asynchronous, so a slow `icacls` never stalls the
 * node's heartbeat. Rejects when the ACL could not be applied; the caller
 * fails closed.
 */
export function restrictDirectoryToOwnerWindows(dirPath: string): Promise<void> {
	const user = process.env.USERDOMAIN
		? `${process.env.USERDOMAIN}\\${process.env.USERNAME ?? ''}`
		: (process.env.USERNAME ?? '');
	if (!user.trim() || user.trim() === '\\' || user.trim().endsWith('\\')) {
		return Promise.reject(new Error('Cannot determine the current Windows user to grant the directory to'));
	}
	const icacls = planProbeSpawn('icacls', currentProbeSpawnDeps());
	return new Promise((resolve, reject) => {
		execFile(
			icacls?.file ?? 'icacls',
			windowsOwnerOnlyDirectoryAclArgs(dirPath, user),
			{ windowsHide: true, timeout: 10_000, ...(icacls ? { cwd: icacls.cwd, env: icacls.env } : {}) },
			(error) => (error ? reject(new Error(`icacls failed: ${error.message}`)) : resolve())
		);
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

/**
 * True when the path is an existing REGULAR FILE this process may execute.
 * A directory (or a socket, a device) is never an executable, even though
 * it may exist and — on POSIX — carry the execute bit.
 */
export function isExecutableFile(filePath: string): boolean {
	try {
		if (!existsSync(filePath) || !statSync(filePath).isFile()) {
			return false;
		}
		if (process.platform === 'win32') {
			// Windows has no execute bit; a regular file is the whole test.
			return true;
		}
		accessSync(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Node lifecycle (self-build slice AR) — the file stamp the model-CLI
 * compatibility probe keys its cache on: modification time + size, so a CLI
 * upgraded in place is re-probed on the very next ask. Null when the file
 * cannot be stat'ed (the probe then falls back to a time-boxed cache).
 */
export async function statModelCliFile(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
	try {
		const stat = await fsp.stat(filePath);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return null;
	}
}

/** Resolve a bare command name on `PATH`, or null. */
export function lookupOnPath(command: string): string | null {
	const hits = lookupAllOnPath(command);
	return hits.length > 0 ? hits[0] : null;
}

/**
 * Every `PATH` hit for a bare command, in `which`/`where` order.
 *
 * Windows `where` lists each launchable form (`claude`, `claude.cmd`);
 * the model-CLI probe needs the whole list to pick one `cmd.exe` can
 * actually run, so the single-hit variant above is a view over this.
 */
export function lookupAllOnPath(command: string): string[] {
	const which = planProbeSpawn(process.platform === 'win32' ? 'where' : 'which', currentProbeSpawnDeps());
	try {
		const output = execFileSync(which?.file ?? 'which', [command], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5_000,
			...(which ? { cwd: which.cwd, env: which.env } : {})
		});
		return output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
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
	const environment = readEnvironment(
		{
			platform: process.platform,
			arch: process.arch,
			version: process.version,
			env: process.env
		},
		resolveBrowserPath,
		{ fileExists: isExecutableFile, lookupOnPath }
	);
	// Agent execution v2 — the model CLIs this machine can drive, resolved
	// once here for the same reason the browser is: the tag and the
	// executor must point at the same binary.
	const modelCli = resolveModelCliPaths({
		env: process.env,
		platform: process.platform,
		fileExists: isExecutableFile,
		lookupAllOnPath
	});
	environment.modelCli = modelCli.paths;
	environment.modelCliNotes = modelCli.notes;
	return environment;
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
 *
 * `firstSampleWindowMs > 0` (computer health, FL-03) waits only when there is
 * no previous reading — the FIRST call — and diffs against the previous call
 * after that. The health snapshot needs exactly this: its CPU figure is the
 * average since the last beat, and its very first figure must be a real
 * measurement, never the "0% admits work" bias above, which would be a value
 * the machine did not report. Give the health probe its OWN instance: two
 * callers sharing one would each measure only the gap since the other.
 */
export function createResourceProbe(
	options: { sampleWindowMs?: number; firstSampleWindowMs?: number } = {}
): ResourceProbe {
	const everyWindowMs = Math.max(options.sampleWindowMs ?? 0, 0);
	const firstWindowMs = Math.max(options.firstSampleWindowMs ?? 0, 0);
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
			const windowMs = everyWindowMs > 0 ? everyWindowMs : previous === null ? firstWindowMs : 0;
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
		},
		// Computer health (FL-03): the same `statfs`, read whole. Null on the
		// same failures, and on any figure that is not a sane byte count.
		volume: async (targetPath: string): Promise<DiskVolumeReading | null> => {
			try {
				const stats = await fsp.statfs(targetPath);
				const block = Number(stats.bsize);
				const reading = {
					totalBytes: Number(stats.blocks) * block,
					freeBytes: Number(stats.bfree) * block,
					availableBytes: Number(stats.bavail) * block
				};
				const sane = Object.values(reading).every((value) => Number.isFinite(value) && value >= 0);
				return sane && reading.totalBytes > 0 ? reading : null;
			} catch {
				return null;
			}
		}
	};
}

/**
 * Real host facts for the health probe (FL-03): `node:os` only, nothing
 * spawned. The probe decides what each fact means per platform (the load
 * average Windows always reports as zero is dropped THERE, where it is
 * tested); this adapter only reads.
 */
export function createHealthProbeIo(runner: CommandRunner): HealthProbeIo {
	return {
		platform: process.platform,
		runner,
		// Its own sampler — see `createResourceProbe` on why it is never shared
		// with the admission gate — whose first reading is a real 250 ms one.
		resourceProbe: createResourceProbe({ firstSampleWindowMs: 250 }),
		host: {
			loadAvg1: () => os.loadavg()[0] ?? null,
			uptimeSec: () => os.uptime(),
			cores: () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length)
		},
		disk: createDiskProbe(),
		pathExists: async (target: string) => {
			try {
				await fsp.access(target);
				return true;
			} catch {
				return false;
			}
		}
	};
}

/** Node 22 ships a global fetch; the core only needs `ok`/`status`/`text()`. */
export const systemFetch: FetchLike = (url, init) =>
	fetch(url, {
		method: init.method,
		headers: init.headers,
		// fetch refuses any body on a GET or HEAD, even an empty one; the core's
		// GETs (the Ever ID sign-in's configuration reads) carry an empty one.
		...(init.method === 'GET' || init.method === 'HEAD' ? {} : { body: init.body }),
		...(init.signal ? { signal: init.signal } : {})
	});

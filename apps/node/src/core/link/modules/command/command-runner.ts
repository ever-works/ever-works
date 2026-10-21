import { spawn, type ChildProcess } from 'child_process';
import { constants as osConstants } from 'os';
import { FLEET_COMMAND_DATA_CHUNK_BYTES, FLEET_COMMAND_MAX_OUTPUT_BYTES } from '@ever-works/contracts';
import { terminateNodeProcessTree } from '../../../executors/acceptance-checks';

/**
 * Commands on computers (FL-12, spec FR-2, FR-5, FR-7, U1, U6, U7) — one
 * command in the machine owner's login shell, bounded.
 *
 *  - **Shell.** The argv prefix the caller resolved (`$SHELL -l` / `pwsh
 *    -NoLogo`, FL-04's `resolveLoginShell`) plus `-c <command>` on POSIX and
 *    `-NonInteractive -Command <command>` on Windows. Never `shell: true`: the
 *    command is ONE argument to the login shell, so nothing re-parses it.
 *  - **No stdin.** `stdio: ['ignore', 'pipe', 'pipe']` — a prompt reads EOF and
 *    fails, it never waits for an answer nobody can give.
 *  - **Output.** stdout and stderr interleaved as emitted, in chunks of at most
 *    64 KiB, until 10 MiB; past the cap the pipes are still drained (a full
 *    pipe would block the command) but nothing more is kept or sent.
 *  - **Timeout.** The process tree is stopped (SIGTERM to the group, SIGKILL
 *    after the grace; `taskkill /T /F` on Windows) — within 5 s of the
 *    deadline by default.
 *  - **Tree.** POSIX runs it in its own process group (`detached`), so a
 *    stop reaches every child the shell started.
 *
 * Pure of the link: the caller decides where the bytes go.
 */

export interface CommandRunnerOptions {
	command: string;
	cwd: string;
	timeoutSec: number;
	platform: string;
	/** The scrubbed environment (`buildNodeCheckEnv`). */
	env: Record<string, string>;
	/** The login shell's argv prefix (`['/bin/zsh', '-l']`, `['pwsh', '-NoLogo']`). */
	shell: readonly string[];
	/** Output kept and sent at most (default 10 MiB). */
	maxOutputBytes?: number;
	/** Largest chunk handed to `onData` (default 64 KiB). */
	chunkBytes?: number;
	/** SIGTERM → SIGKILL grace (default 5 s). */
	killGraceMs?: number;
	onData(chunk: Uint8Array): void;
	/** The cap was reached (once). */
	onCapped?(bytes: number): void;
	/** The timeout fired (once), just before the tree is stopped. */
	onTimeout?(): void;
	/** Test seams. */
	spawnFn?: typeof spawn;
	terminateTree?: (child: ChildProcess) => Promise<void>;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface CommandExit {
	/** The process exit code, or 128 + the signal number when a signal ended it, or null. */
	exitCode: number | null;
	signal: string | null;
	/** Bytes kept (≤ the cap). */
	bytes: number;
	capped: boolean;
	timedOut: boolean;
}

export interface CommandRunHandle {
	readonly pid: number | null;
	/** The shell as a person reads it (`/bin/zsh -l`), never the command. */
	readonly shell: string;
	/** Stop the process tree (idempotent). */
	stop(): void;
	readonly done: Promise<CommandExit>;
}

/** The argv for one command in the login shell. */
export function commandArgv(platform: string, shell: readonly string[], command: string): string[] {
	if (platform === 'win32') return [...shell, '-NonInteractive', '-Command', command];
	return [...shell, '-c', command];
}

/** How long after the process exited its pipes may stay open (a background child holding them). */
const PIPE_DRAIN_GRACE_MS = 2_000;

/**
 * Start the command. Resolves once the process exists (`spawn`), rejects when
 * the shell could not start at all (spec U7: the caller answers
 * `operation_failed` with the first line of the error).
 */
export function startCommand(options: CommandRunnerOptions): Promise<CommandRunHandle> {
	const spawnFn = options.spawnFn ?? spawn;
	const terminateTree = options.terminateTree ?? terminateNodeProcessTree;
	const setTimer =
		options.setTimer ??
		((callback: () => void, ms: number) => {
			const timer = setTimeout(callback, ms);
			timer.unref?.();
			return timer;
		});
	const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
	const maxBytes = Math.max(0, options.maxOutputBytes ?? FLEET_COMMAND_MAX_OUTPUT_BYTES);
	const chunkBytes = Math.max(1, options.chunkBytes ?? FLEET_COMMAND_DATA_CHUNK_BYTES);
	const killGraceMs = Math.max(0, options.killGraceMs ?? 5_000);
	const isWindows = options.platform === 'win32';
	const [program, ...args] = commandArgv(options.platform, options.shell, options.command);

	return new Promise<CommandRunHandle>((resolveStart, rejectStart) => {
		let child: ChildProcess;
		try {
			child = spawnFn(program, args, {
				cwd: options.cwd,
				env: options.env,
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: !isWindows,
				windowsHide: true
			});
		} catch (error) {
			rejectStart(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		let started = false;
		let bytes = 0;
		let capped = false;
		let timedOut = false;
		let stopping = false;
		let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		let settled = false;
		let resolveDone: (exit: CommandExit) => void = () => undefined;
		const done = new Promise<CommandExit>((resolve) => {
			resolveDone = resolve;
		});
		const timers = new Set<unknown>();
		const later = (callback: () => void, ms: number) => {
			const handle = setTimer(() => {
				timers.delete(handle);
				callback();
			}, ms);
			timers.add(handle);
			return handle;
		};

		const onOutput = (raw: Buffer | string) => {
			const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw;
			if (capped || buffer.byteLength === 0) return;
			const room = maxBytes - bytes;
			const kept = buffer.byteLength > room ? buffer.subarray(0, room) : buffer;
			bytes += kept.byteLength;
			for (let offset = 0; offset < kept.byteLength; offset += chunkBytes) {
				const piece = kept.subarray(offset, Math.min(kept.byteLength, offset + chunkBytes));
				try {
					options.onData(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength));
				} catch {
					// the caller's failure is its own; the pipe keeps draining
				}
			}
			if (buffer.byteLength > room || bytes >= maxBytes) {
				capped = true;
				try {
					options.onCapped?.(bytes);
				} catch {
					// the caller's failure is its own
				}
			}
		};
		child.stdout?.on('data', onOutput);
		child.stderr?.on('data', onOutput);

		const finish = () => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimer(timer);
			timers.clear();
			const signal = exited?.signal ?? null;
			let exitCode = exited?.code ?? null;
			if (exitCode === null && signal) {
				const number = (osConstants.signals as Record<string, number | undefined>)[signal];
				if (typeof number === 'number') exitCode = 128 + number;
			}
			resolveDone({ exitCode, signal, bytes, capped, timedOut });
		};

		const stop = () => {
			if (stopping || settled) return;
			stopping = true;
			if (isWindows) {
				void terminateTree(child).catch(() => undefined);
				return;
			}
			const pid = child.pid;
			try {
				if (typeof pid === 'number' && pid > 0) process.kill(-pid, 'SIGTERM');
				else child.kill('SIGTERM');
			} catch {
				// already gone
			}
			later(() => {
				if (!settled) void terminateTree(child).catch(() => undefined);
			}, killGraceMs);
		};

		child.once('spawn', () => {
			started = true;
			if (options.timeoutSec > 0) {
				later(() => {
					if (settled) return;
					timedOut = true;
					try {
						options.onTimeout?.();
					} catch {
						// the caller's failure is its own
					}
					stop();
				}, options.timeoutSec * 1000);
			}
			resolveStart({
				pid: typeof child.pid === 'number' ? child.pid : null,
				shell: options.shell.join(' '),
				stop,
				done
			});
		});
		child.once('error', (error) => {
			if (!started) {
				settled = true;
				rejectStart(error);
				return;
			}
			// An error after spawn (a kill that failed): the exit / close still settles it.
		});
		child.once('exit', (code, signal) => {
			exited = { code, signal };
			// A background child may keep the pipes open: do not wait for them forever.
			later(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish();
			}, PIPE_DRAIN_GRACE_MS);
		});
		child.once('close', (code, signal) => {
			if (!exited) exited = { code, signal };
			finish();
		});
	});
}

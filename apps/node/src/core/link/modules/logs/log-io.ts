import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { StringDecoder } from 'string_decoder';
import { FLEET_LOGS_STOP_GRACE_MS, type FleetLinkErrorCode, type FleetLogLevel } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { buildNodeCheckEnv } from '../../../executors/acceptance-checks';

/**
 * Logs on computers (FL-08) — everything the `logs` module touches on the
 * machine, behind one seam so every reader and the channel are testable
 * without a host:
 *
 *  - `runner` — short, buffered commands (listing: `systemctl`, `docker ps`);
 *  - `spawn` — long-lived children whose stdout is read line by line
 *    (`journalctl -f`, `docker logs -f`, `log stream`), always with argv,
 *    NEVER a shell string, in the scrubbed child environment
 *    (`buildNodeCheckEnv`), hidden on Windows, killed within
 *    {@link FLEET_LOGS_STOP_GRACE_MS} of a stop;
 *  - `fs` — the few file calls a tail needs.
 *
 * The Docker daemon socket is never opened: only the CLI runs (spec FR-8).
 */

/** Which stream of a child a line came from. */
export type LogChildStream = 'stdout' | 'stderr';

export interface LogChild {
	/** One callback per complete line (a trailing `\r` stripped), in arrival order. */
	onLine(listener: (line: string, stream: LogChildStream) => void): void;
	/** Exactly once: the exit code (null when killed or never started) and, for a spawn failure, its code. */
	onExit(listener: (code: number | null, spawnError?: string) => void): void;
	/** Stop it: a polite signal, then a hard one after the grace. Idempotent. */
	kill(): void;
}

export type LogSpawn = (command: string, args: readonly string[]) => LogChild;

export interface LogFileStat {
	size: number;
	mtimeMs: number;
	/** Inode (POSIX) or file index (Windows); 0 when the platform gives none. */
	ino: number;
	isFile: boolean;
	isDirectory: boolean;
}

export interface LogDirEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface LogFs {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<LogFileStat>;
	readdir(path: string): Promise<LogDirEntry[]>;
	/** True when this process may read the file. */
	canRead(path: string): Promise<boolean>;
	/** Up to `length` bytes at `position` (fewer at the end of the file). */
	read(path: string, position: number, length: number): Promise<Uint8Array>;
}

export interface LogTimers {
	now(): number;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface LogIo extends LogTimers {
	/** `process.platform`. */
	platform: string;
	runner: CommandRunner;
	spawn: LogSpawn;
	fs: LogFs;
	homedir: string;
	/** The OS account the node runs as (the journal-group hint names it). */
	user: string;
	/** Root on POSIX, an administrator on Windows; probed once and cached by the caller. */
	isElevated(): Promise<boolean>;
}

/** One line a reader produced, before the scan and the wire. */
export interface RawLogLine {
	ts: string | null;
	level: FleetLogLevel;
	text: string;
}

/** A typed refusal a reader raises; the channel carries it as `{ code, hint }`. */
export class LogReadError extends Error {
	constructor(
		readonly code: FleetLinkErrorCode,
		readonly hint: string
	) {
		super(hint);
		this.name = 'LogReadError';
	}
}

/** One stderr line, first line only, bounded — what a person reads in "journalctl exited 1: …". */
export function firstLine(text: string, max = 200): string {
	const line = (text.split(/\r?\n/, 1)[0] ?? '').trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ─── Collecting a bounded tail from a child ────────────────────────────────

export interface CollectOptions<T> {
	/** Keep at most this many parsed entries (the newest). */
	max: number;
	/** Parse one stdout line; null skips it. */
	parse(line: string): T | null;
	/** Also parse stderr lines as entries (Docker writes a container's stderr there). */
	stderrIsData?: boolean;
	timeoutMs: number;
	/** On timeout with entries collected, answer them instead of failing (a busy unified log). */
	partialOnTimeout?: boolean;
}

export interface CollectResult<T> {
	entries: T[];
	stderr: string[];
	code: number | null;
	timedOut: boolean;
	spawnError?: string;
}

/** Run a child to its end (or the timeout), keeping its newest `max` entries in a ring. */
export function collectChild<T>(
	io: Pick<LogIo, 'spawn' | 'setTimer' | 'clearTimer'>,
	command: string,
	args: readonly string[],
	options: CollectOptions<T>
): Promise<CollectResult<T>> {
	return new Promise((resolve) => {
		const entries: T[] = [];
		const stderr: string[] = [];
		let settled = false;
		let timedOut = false;
		const child = io.spawn(command, args);
		const push = (entry: T | null) => {
			if (entry === null) return;
			entries.push(entry);
			if (entries.length > options.max) entries.shift();
		};
		child.onLine((line, stream) => {
			if (stream === 'stdout') push(options.parse(line));
			else if (options.stderrIsData) push(options.parse(line));
			if (stream === 'stderr' && stderr.length < 20) stderr.push(line);
		});
		let timer: unknown = null;
		const finish = (code: number | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			if (timer !== null) io.clearTimer(timer);
			resolve({ entries: [...entries], stderr, code, timedOut, ...(spawnError ? { spawnError } : {}) });
		};
		timer = io.setTimer(() => {
			timedOut = true;
			child.kill();
			if (options.partialOnTimeout && entries.length > 0) finish(null);
		}, options.timeoutMs);
		child.onExit((code, spawnError) => finish(code, spawnError));
	});
}

// ─── The real machine ──────────────────────────────────────────────────────

class NodeLogChild implements LogChild {
	private lineListeners: Array<(line: string, stream: LogChildStream) => void> = [];
	private exitListeners: Array<(code: number | null, spawnError?: string) => void> = [];
	private exited: { code: number | null; spawnError?: string } | null = null;
	private killed = false;
	private hardKill: NodeJS.Timeout | null = null;
	private readonly child: ReturnType<typeof spawn> | null;

	constructor(command: string, args: readonly string[], maxLineChars: number) {
		let child: ReturnType<typeof spawn> | null = null;
		try {
			child = spawn(command, [...args], {
				env: buildNodeCheckEnv(),
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				shell: false
			});
		} catch (error) {
			this.child = null;
			const code = (error as NodeJS.ErrnoException)?.code ?? 'EFAIL';
			queueMicrotask(() => this.exit(null, code));
			return;
		}
		this.child = child;
		this.pipe(child.stdout, 'stdout', maxLineChars);
		this.pipe(child.stderr, 'stderr', maxLineChars);
		child.on('error', (error: NodeJS.ErrnoException) => this.exit(null, error.code ?? 'EFAIL'));
		child.on('close', (code) => this.exit(typeof code === 'number' ? code : null));
	}

	onLine(listener: (line: string, stream: LogChildStream) => void): void {
		this.lineListeners.push(listener);
	}

	onExit(listener: (code: number | null, spawnError?: string) => void): void {
		if (this.exited) {
			listener(this.exited.code, this.exited.spawnError);
			return;
		}
		this.exitListeners.push(listener);
	}

	kill(): void {
		if (this.killed || this.exited || !this.child) return;
		this.killed = true;
		try {
			this.child.kill('SIGTERM');
		} catch {
			// already gone
		}
		this.hardKill = setTimeout(() => {
			try {
				if (!this.exited) this.child?.kill('SIGKILL');
			} catch {
				// already gone
			}
		}, FLEET_LOGS_STOP_GRACE_MS);
		this.hardKill.unref?.();
	}

	private pipe(stream: NodeJS.ReadableStream | null, name: LogChildStream, maxLineChars: number): void {
		if (!stream) return;
		const decoder = new StringDecoder('utf8');
		let carry = '';
		const emit = (line: string) => {
			const text = line.endsWith('\r') ? line.slice(0, -1) : line;
			for (const listener of this.lineListeners) {
				try {
					listener(text, name);
				} catch {
					// a listener's failure is its own
				}
			}
		};
		stream.on('data', (chunk: Buffer) => {
			carry += decoder.write(chunk);
			let newline = carry.indexOf('\n');
			while (newline >= 0) {
				emit(carry.slice(0, newline));
				carry = carry.slice(newline + 1);
				newline = carry.indexOf('\n');
			}
			// A line longer than the bound is emitted in pieces rather than held forever.
			if (carry.length > maxLineChars) {
				emit(carry);
				carry = '';
			}
		});
		stream.on('end', () => {
			carry += decoder.end();
			if (carry.length > 0) emit(carry);
			carry = '';
		});
	}

	private exit(code: number | null, spawnError?: string): void {
		if (this.exited) return;
		this.exited = spawnError ? { code, spawnError } : { code };
		if (this.hardKill) clearTimeout(this.hardKill);
		for (const listener of this.exitListeners) {
			try {
				listener(code, spawnError);
			} catch {
				// a listener's failure is its own
			}
		}
		this.exitListeners = [];
	}
}

/** The machine's own `LogIo`: real children, real files, real timers. */
export function createNodeLogIo(input: {
	platform: string;
	runner: CommandRunner;
	homedir: string;
	user: string;
	/** POSIX uid (root is 0); undefined on Windows. */
	uid?: number;
	maxLineChars?: number;
}): LogIo {
	const maxLineChars = input.maxLineChars ?? 64 * 1024;
	let elevated: Promise<boolean> | null = null;
	return {
		platform: input.platform,
		runner: input.runner,
		homedir: input.homedir,
		user: input.user,
		spawn: (command, args) => new NodeLogChild(command, args, maxLineChars),
		fs: {
			realpath: (path) => fs.realpath(path),
			stat: async (path) => {
				const stat = await fs.stat(path);
				return {
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					ino: Number(stat.ino) || 0,
					isFile: stat.isFile(),
					isDirectory: stat.isDirectory()
				};
			},
			readdir: async (path) => {
				const entries = await fs.readdir(path, { withFileTypes: true });
				return entries.map((entry) => ({
					name: entry.name,
					isFile: entry.isFile(),
					isDirectory: entry.isDirectory(),
					isSymbolicLink: entry.isSymbolicLink()
				}));
			},
			canRead: async (path) => {
				try {
					const handle = await fs.open(path, 'r');
					await handle.close();
					return true;
				} catch {
					return false;
				}
			},
			read: async (path, position, length) => {
				const handle = await fs.open(path, 'r');
				try {
					const buffer = Buffer.alloc(length);
					const { bytesRead } = await handle.read(buffer, 0, length, position);
					return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
				} finally {
					await handle.close();
				}
			}
		},
		isElevated: () => {
			if (!elevated) {
				elevated =
					input.platform === 'win32'
						? input.runner
								.run('net', ['session'], { timeoutMs: 5_000 })
								.then((result) => result.code === 0)
								.catch(() => false)
						: Promise.resolve(input.uid === 0);
			}
			return elevated;
		},
		now: () => Date.now(),
		setTimer: (callback, ms) => {
			const timer = setTimeout(callback, ms);
			timer.unref?.();
			return timer;
		},
		clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout)
	};
}

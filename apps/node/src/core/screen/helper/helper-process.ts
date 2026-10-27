import { spawn } from 'node:child_process';
import type { Logger } from '../../logger';
import { HelperMessageDecoder, type HelperMessage } from './helper-protocol';

/**
 * Desktop view & control (FL-07, FR-13, plan §6.1) — one running screen
 * helper: spawned as a direct child of the node over its stdin / stdout (the
 * P1 transport on every OS; the per-OS launches into the interactive session
 * are follow-ups, `PACKAGING.md`).
 *
 * The child gets NO environment but what capture needs — `DISPLAY`,
 * `XAUTHORITY`, `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY` on Linux, `SystemRoot` /
 * `WINDIR` on Windows — never a credential, a token or the node's own config.
 * Closing its stdin ends it (the helper exits on end of input); a helper that
 * does not leave within {@link HELPER_STOP_GRACE_MS} is killed.
 */

/** A stopping helper is killed after this long. */
export const HELPER_STOP_GRACE_MS = 2_000;
/** At most this much of the helper's last stderr line is kept for the exit reason (it never carries pictures). */
const STDERR_LINE_MAX = 300;

/** The child process surface the supervisor uses — a seam so the specs run without a binary. */
export interface HelperChild {
	readonly stdin: { write(chunk: Uint8Array): boolean; end(): void } | null;
	readonly stdout: { on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown } | null;
	readonly stderr: { on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown } | null;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

export type HelperSpawner = (path: string, env: Record<string, string>) => HelperChild;

/** The real spawner: no shell, no window, piped stdio, the minimal environment. */
export const spawnHelperChild: HelperSpawner = (path, env) =>
	spawn(path, [], {
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		shell: false
	}) as unknown as HelperChild;

const ENVIRONMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
	linux: ['DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY'],
	win32: ['SystemRoot', 'WINDIR'],
	darwin: []
};

/** The only environment the helper receives (plan §11 "helper least privilege"). */
export function helperEnvironment(
	env: Readonly<Record<string, string | undefined>>,
	platform: string
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of ENVIRONMENT_KEYS[platform] ?? []) {
		const value = env[key];
		if (typeof value === 'string' && value.length > 0 && value.length <= 4096) out[key] = value;
	}
	return out;
}

export interface HelperExit {
	code: number | null;
	signal: string | null;
	/** Why the node ended it (`stopped`), or why the stream broke (`a 9-byte message`), or null. */
	reason: string | null;
}

export interface HelperProcessHandlers {
	onMessage(message: HelperMessage): void;
	onExit(exit: HelperExit): void;
}

export class HelperProcess {
	private readonly decoder = new HelperMessageDecoder();
	private stopping = false;
	private exited = false;
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private stopReason: string | null = null;
	private lastStderrLine: string | null = null;

	private constructor(
		private readonly child: HelperChild,
		private readonly handlers: HelperProcessHandlers,
		private readonly logger?: Logger
	) {}

	/** Start the helper at `path` (already verified by the caller, immediately before this call). */
	static start(
		path: string,
		env: Record<string, string>,
		handlers: HelperProcessHandlers,
		options: { spawner?: HelperSpawner; logger?: Logger } = {}
	): HelperProcess {
		const child = (options.spawner ?? spawnHelperChild)(path, env);
		const helper = new HelperProcess(child, handlers, options.logger);
		helper.wire();
		return helper;
	}

	get running(): boolean {
		return !this.exited;
	}

	/** Send one framed message; false when the helper is gone or stopping. */
	send(message: Uint8Array): boolean {
		if (this.exited || this.stopping || !this.child.stdin) return false;
		try {
			this.child.stdin.write(message);
			return true;
		} catch {
			return false;
		}
	}

	/** End the helper: close its stdin, kill it after the grace. Idempotent. */
	stop(reason = 'stopped'): void {
		if (this.exited || this.stopping) return;
		this.stopping = true;
		this.stopReason = reason;
		try {
			this.child.stdin?.end();
		} catch {
			// already closed
		}
		this.killTimer = setTimeout(() => {
			if (!this.exited) this.child.kill('SIGKILL');
		}, HELPER_STOP_GRACE_MS);
		this.killTimer.unref?.();
	}

	private wire(): void {
		this.child.stdout?.on('data', (chunk) => {
			if (this.exited) return;
			const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
			const messages = this.decoder.push(bytes);
			for (const message of messages) {
				try {
					this.handlers.onMessage(message);
				} catch {
					// a handler's failure is its own
				}
			}
			if (this.decoder.broken) {
				this.logger?.warn(`The screen helper sent ${this.decoder.broken}; stopping it`);
				this.stop(this.decoder.broken);
			}
		});
		this.child.stderr?.on('data', (chunk) => {
			const text = Buffer.from(chunk).toString('utf8');
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed) this.lastStderrLine = trimmed.slice(0, STDERR_LINE_MAX);
			}
		});
		this.child.on('error', (error) => {
			this.finish({ code: null, signal: null, reason: error.message.split(/\r?\n/, 1)[0].slice(0, 200) });
		});
		this.child.on('exit', (code, signal) => {
			this.finish({ code, signal, reason: this.stopReason ?? this.lastStderrLine });
		});
	}

	private finish(exit: HelperExit): void {
		if (this.exited) return;
		this.exited = true;
		if (this.killTimer) clearTimeout(this.killTimer);
		try {
			this.handlers.onExit(exit);
		} catch {
			// a handler's failure is its own
		}
	}
}

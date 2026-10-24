import { FLEET_SESSION_END_GRACE_MS } from '@ever-works/contracts';
import type { PtyFactory, PtyProcess } from './pty-host';

/**
 * Sessions on computers (FL-04) — one session's process inside the daemon.
 *
 * Spawned through the daemon's {@link PtyFactory} with the terminal
 * environment every session gets (`TERM=xterm-256color`,
 * `COLORTERM=truecolor`, `EVER_WORKS_SESSION_ID`) on top of the environment
 * the node composed — the daemon adds nothing else (an owner session runs as
 * the person, in their login; spec FR-12).
 *
 * Ending is two steps (spec FR-18): ask the process to stop, and if it is
 * still there after {@link FLEET_SESSION_END_GRACE_MS}, kill it. The exit is
 * reported once, with the code when the platform gave one.
 */

export interface SessionProcessOptions {
	sessionId: string;
	command: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
	factory: PtyFactory;
	/** Timer seam (tests); defaults to the real clock. */
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface SessionExit {
	exitCode: number | null;
	signal: number | null;
}

/** The terminal environment layered over what the node composed. */
export function sessionTerminalEnv(sessionId: string, env: Record<string, string>): Record<string, string> {
	return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', EVER_WORKS_SESSION_ID: sessionId };
}

export class SessionProcess {
	private readonly pty: PtyProcess;
	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<(exit: SessionExit) => void>();
	private exit: SessionExit | null = null;
	private killTimer: unknown = null;
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(options: SessionProcessOptions) {
		this.setTimer =
			options.setTimer ??
			((callback, ms) => {
				const timer = setTimeout(callback, ms);
				timer.unref?.();
				return timer;
			});
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
		const [command, ...args] = options.command;
		this.pty = options.factory({
			command,
			args,
			cwd: options.cwd,
			env: sessionTerminalEnv(options.sessionId, options.env),
			cols: options.cols,
			rows: options.rows
		});
		this.pty.onData((data) => {
			for (const listener of [...this.dataListeners]) {
				try {
					listener(data);
				} catch {
					// a listener's failure is its own
				}
			}
		});
		this.pty.onExit((event) => this.finish({ exitCode: event.exitCode ?? null, signal: event.signal ?? null }));
	}

	get pid(): number | null {
		return this.pty.pid;
	}

	get alive(): boolean {
		return this.exit === null;
	}

	get exitInfo(): SessionExit | null {
		return this.exit;
	}

	onData(listener: (data: string) => void): () => void {
		this.dataListeners.add(listener);
		return () => {
			this.dataListeners.delete(listener);
		};
	}

	/** Called once, when the process is gone. A listener added after the exit is called at once. */
	onExit(listener: (exit: SessionExit) => void): () => void {
		if (this.exit) {
			listener(this.exit);
			return () => undefined;
		}
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	write(data: string): void {
		if (!this.alive) return;
		try {
			this.pty.write(data);
		} catch {
			// a write racing the exit
		}
	}

	resize(cols: number, rows: number): void {
		if (!this.alive) return;
		try {
			this.pty.resize(cols, rows);
		} catch {
			// a resize racing the exit
		}
	}

	/** Stop it: terminate now, kill after `graceMs` if it is still running. Idempotent. */
	end(graceMs: number = FLEET_SESSION_END_GRACE_MS): void {
		if (!this.alive || this.killTimer !== null) return;
		this.pty.kill(false);
		this.killTimer = this.setTimer(
			() => {
				this.killTimer = null;
				if (this.alive) this.pty.kill(true);
			},
			Math.max(0, graceMs)
		);
	}

	private finish(exit: SessionExit): void {
		if (this.exit) return;
		this.exit = exit;
		if (this.killTimer !== null) {
			this.clearTimer(this.killTimer);
			this.killTimer = null;
		}
		for (const listener of [...this.exitListeners]) {
			try {
				listener(exit);
			} catch {
				// a listener's failure is its own
			}
		}
		this.exitListeners.clear();
		this.dataListeners.clear();
	}
}

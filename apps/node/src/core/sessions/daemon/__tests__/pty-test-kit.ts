import { spawn } from 'node:child_process';
import type { PtyFactory, PtyProcess, PtySpawnOptions } from '../pty-host';

/**
 * Test-only process hosts for the session daemon. Neither is a production
 * pipe floor (the daemon has none, by design): one is an in-memory terminal
 * the test drives by hand, the other runs a REAL child process over pipes so
 * the daemon's process lifecycle (output, exit codes, terminate-then-kill)
 * is exercised end to end on machines without the native PTY addon.
 */

export class FakePty implements PtyProcess {
	readonly pid = 4242;
	readonly writes: string[] = [];
	readonly resizes: Array<{ cols: number; rows: number }> = [];
	readonly kills: boolean[] = [];
	private dataListeners: Array<(data: string) => void> = [];
	private exitListeners: Array<(exit: { exitCode: number | null; signal?: number | null }) => void> = [];
	exited = false;

	constructor(readonly options: PtySpawnOptions) {}

	onData(listener: (data: string) => void): void {
		this.dataListeners.push(listener);
	}

	onExit(listener: (exit: { exitCode: number | null; signal?: number | null }) => void): void {
		this.exitListeners.push(listener);
	}

	write(data: string): void {
		this.writes.push(data);
	}

	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows });
	}

	kill(force?: boolean): void {
		this.kills.push(force === true);
	}

	/** The process prints. */
	emit(data: string): void {
		for (const listener of this.dataListeners) listener(data);
	}

	/** The process exits. */
	exit(exitCode: number | null): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of this.exitListeners) listener({ exitCode, signal: null });
	}
}

/** A factory that records every fake it hands out. */
export function fakePtyFactory(): { factory: PtyFactory; spawned: FakePty[] } {
	const spawned: FakePty[] = [];
	return {
		spawned,
		factory: (options) => {
			const pty = new FakePty(options);
			spawned.push(pty);
			return pty;
		}
	};
}

/** A real child process over pipes (no terminal): output, input, exit codes, signals. */
export const pipePtyFactory: PtyFactory = (options) => {
	const child = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	});
	const dataListeners: Array<(data: string) => void> = [];
	const exitListeners: Array<(exit: { exitCode: number | null; signal?: number | null }) => void> = [];
	let exited: { exitCode: number | null } | null = null;
	const onChunk = (chunk: Buffer) => {
		for (const listener of dataListeners) listener(chunk.toString('utf8'));
	};
	child.stdout?.on('data', onChunk);
	child.stderr?.on('data', onChunk);
	child.on('exit', (code) => {
		exited = { exitCode: typeof code === 'number' ? code : null };
		for (const listener of exitListeners) listener({ exitCode: exited.exitCode, signal: null });
	});
	child.on('error', () => {
		if (exited) return;
		exited = { exitCode: null };
		for (const listener of exitListeners) listener({ exitCode: null, signal: null });
	});
	return {
		pid: child.pid ?? null,
		onData: (listener) => dataListeners.push(listener),
		onExit: (listener) => {
			if (exited) listener({ exitCode: exited.exitCode, signal: null });
			else exitListeners.push(listener);
		},
		write: (data) => {
			child.stdin?.write(data);
		},
		resize: () => undefined,
		kill: (force) => {
			try {
				child.kill(force ? 'SIGKILL' : 'SIGTERM');
			} catch {
				// gone
			}
		}
	};
};

/** `node -e <script>` as a session command. */
export function nodeScript(script: string): string[] {
	return [process.execPath, '-e', script];
}

/** Poll until `check` is true or the time runs out. */
export async function eventually(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
	stepMs = 20
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

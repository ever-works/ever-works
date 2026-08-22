import { execFile, spawn, type ChildProcess } from 'node:child_process';

export interface VerifiedExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	windowsHide?: boolean;
	signal?: AbortSignal;
	execFileFn?: typeof execFile;
	terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}

export interface VerifiedExecResult {
	error: Error | null;
	stdout: string | Buffer;
	stderr: string | Buffer;
}

/** Cancellation could not prove every descendant stopped; callers quarantine. */
export class ProcessTreeTerminationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProcessTreeTerminationError';
	}
}

/**
 * Shell-free execFile with whole-tree cancellation. Git may launch SSH,
 * credential, askpass, and remote helpers; aborting only the Git parent can
 * leave those helpers running with credentials, so success is reported only
 * after the detached process tree is proven gone.
 */
export function execFileWithVerifiedCancellation(
	command: string,
	args: readonly string[],
	options: VerifiedExecOptions = {}
): Promise<VerifiedExecResult> {
	if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
	const terminate = options.terminateProcessTree ?? terminateVerifiedProcessTree;

	return new Promise((resolve, reject) => {
		let settled = false;
		let aborting = false;
		let child: ChildProcess;
		const cleanup = (): void => options.signal?.removeEventListener('abort', onAbort);
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const onAbort = (): void => {
			if (settled || aborting) return;
			aborting = true;
			void terminate(child).then(
				() => finish(() => reject(abortError(options.signal))),
				(error) =>
					finish(() =>
						reject(
							new ProcessTreeTerminationError(
								`Git process tree could not be proven stopped: ${errorDetail(error)}`
							)
						)
					)
			);
		};

		try {
			child = startFile(command, args, options, (error, stdout, stderr) => {
				if (aborting) return;
				finish(() => resolve({ error, stdout, stderr }));
			});
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		options.signal?.addEventListener('abort', onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

function startFile(
	command: string,
	args: readonly string[],
	options: VerifiedExecOptions,
	callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
): ChildProcess {
	const processOptions = {
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.env ? { env: options.env } : {}),
		windowsHide: options.windowsHide ?? true,
		detached: true
	};
	if (options.execFileFn) {
		// Compatibility seam for existing deterministic tests. Node accepts
		// spawn's detached option at runtime even though ExecFileOptions omits it.
		return options.execFileFn(
			command,
			[...args],
			{ ...processOptions, maxBuffer: options.maxBuffer } as never,
			callback as never
		);
	}

	const child = spawn(command, [...args], { ...processOptions, stdio: ['ignore', 'pipe', 'pipe'] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let size = 0;
	let launchError: Error | null = null;
	let finished = false;
	const maxBuffer = options.maxBuffer ?? 1024 * 1024;
	const append = (target: Buffer[], chunk: Buffer | string): void => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBuffer && !launchError) {
			launchError = Object.assign(new Error(`process output exceeded ${maxBuffer} bytes`), {
				code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
			});
			void terminateVerifiedProcessTree(child).catch(() => child.kill('SIGKILL'));
			return;
		}
		target.push(buffer);
	};
	child.stdout?.on('data', (chunk: Buffer | string) => append(stdout, chunk));
	child.stderr?.on('data', (chunk: Buffer | string) => append(stderr, chunk));
	child.on('error', (error) => {
		launchError = error;
	});
	child.on('close', (code, signal) => {
		if (finished) return;
		finished = true;
		const error =
			launchError ??
			(code === 0
				? null
				: Object.assign(new Error(`process exited ${code ?? signal ?? 'unknown'}`), {
						code: code ?? 1,
						signal
					}));
		callback(error, Buffer.concat(stdout), Buffer.concat(stderr));
	});
	return child;
}

const TREE_VERIFY_TIMEOUT_MS = 2_000;
const TREE_VERIFY_POLL_MS = 20;

export async function terminateVerifiedProcessTree(child: ChildProcess): Promise<void> {
	const pid = child.pid;
	if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
		throw new Error('spawned process has no valid process id');
	}

	let primary: unknown;
	try {
		if (process.platform === 'win32') {
			await execTreeKill(pid!);
			await waitForGone(() => isProcessAlive(pid!), `process ${pid} remained alive after taskkill`);
			return;
		}
		process.kill(-pid!, 'SIGKILL');
		await waitForGone(() => isProcessGroupAlive(pid!), `process group ${pid} remained alive after SIGKILL`);
		return;
	} catch (error) {
		primary = error;
	}

	let fallback: unknown;
	try {
		const requested = child.kill('SIGKILL');
		if (!requested && isProcessAlive(pid!)) throw new Error('direct child kill was refused');
		await waitForGone(() => isProcessAlive(pid!), `process ${pid} remained alive after fallback`);
		if (process.platform === 'win32') {
			throw new Error('direct-child fallback cannot prove Windows descendants stopped');
		}
		await waitForGone(() => isProcessGroupAlive(pid!), `process group ${pid} remained alive after fallback`);
		return;
	} catch (error) {
		fallback = error;
	}
	throw new Error(
		`native whole-tree termination failed (${errorDetail(primary)}); fallback was unproven (${errorDetail(fallback)})`
	);
}

function execTreeKill(pid: number): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			'taskkill',
			['/PID', String(pid), '/T', '/F'],
			{ windowsHide: true, timeout: TREE_VERIFY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(error) => (error ? reject(error) : resolve())
		);
	});
}

async function waitForGone(alive: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + TREE_VERIFY_TIMEOUT_MS;
	while (alive()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise<void>((resolve) => setTimeout(resolve, TREE_VERIFY_POLL_MS));
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Git process was cancelled');
	error.name = 'AbortError';
	return error;
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

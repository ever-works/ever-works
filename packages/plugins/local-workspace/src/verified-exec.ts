import { execFile, spawn, type ChildProcess } from 'node:child_process';

export interface VerifiedExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	windowsHide?: boolean;
	signal?: AbortSignal;
	execFileFn?: typeof execFile;
	terminateProcessTree?: (child: ChildProcess) => Promise<void>;
	/** Bound an injected/native whole-tree verifier; a timeout is unproven death. */
	terminationTimeoutMs?: number;
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

interface TerminationCoordinator {
	noteAbort(error: Error): void;
	noteOverflow(error: Error): void;
	request(child: ChildProcess): Promise<void>;
	unproven(error: unknown): ProcessTreeTerminationError;
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
	const termination = createTerminationCoordinator(terminate, options.terminationTimeoutMs);

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
			const cancellation = abortError(options.signal);
			termination.noteAbort(cancellation);
			void termination.request(child).then(
				() => finish(() => reject(cancellation)),
				(error) => finish(() => reject(termination.unproven(error)))
			);
		};

		try {
			child = startFile(command, args, options, termination, (error, stdout, stderr) => {
				if (aborting) return;
				if (error instanceof ProcessTreeTerminationError) {
					finish(() => reject(error));
					return;
				}
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
	termination: TerminationCoordinator,
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
	let overflowed = false;
	const maxBuffer = options.maxBuffer ?? 1024 * 1024;
	const complete = (error: Error | null): void => {
		if (finished) return;
		finished = true;
		callback(error, Buffer.concat(stdout), Buffer.concat(stderr));
	};
	const append = (target: Buffer[], chunk: Buffer | string): void => {
		if (overflowed) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBuffer) {
			overflowed = true;
			const overflowError = Object.assign(new Error(`process output exceeded ${maxBuffer} bytes`), {
				code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
			});
			termination.noteOverflow(overflowError);
			void termination.request(child).then(
				() => complete(overflowError),
				(error) => complete(termination.unproven(error))
			);
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
		if (finished || overflowed) return;
		const error =
			launchError ??
			(code === 0
				? null
				: Object.assign(new Error(`process exited ${code ?? signal ?? 'unknown'}`), {
						code: code ?? 1,
						signal
					}));
		complete(error);
	});
	return child;
}

const TREE_VERIFY_TIMEOUT_MS = 2_000;
const TREE_VERIFY_POLL_MS = 20;
const TREE_TERMINATION_DEADLINE_MS = 6_000;

function createTerminationCoordinator(
	terminate: (child: ChildProcess) => Promise<void>,
	timeoutMs?: number
): TerminationCoordinator {
	let attempt: Promise<void> | null = null;
	let abort: Error | null = null;
	let overflow: Error | null = null;
	return {
		noteAbort(error): void {
			abort ??= error;
		},
		noteOverflow(error): void {
			overflow ??= error;
		},
		request(child): Promise<void> {
			attempt ??= terminateWithDeadline(terminate, child, timeoutMs);
			return attempt;
		},
		unproven(error): ProcessTreeTerminationError {
			const context: string[] = [];
			if (overflow) context.push(overflow.message);
			if (abort) context.push(`cancellation requested: ${abort.message}`);
			context.push(`Git process tree could not be proven stopped: ${errorDetail(error)}`);
			const unproven = new ProcessTreeTerminationError(context.join('; '));
			Object.assign(unproven, { cause: overflow ?? abort ?? error });
			return unproven;
		}
	};
}

async function terminateWithDeadline(
	terminate: (child: ChildProcess) => Promise<void>,
	child: ChildProcess,
	timeoutMs = TREE_TERMINATION_DEADLINE_MS
): Promise<void> {
	const boundedMs =
		Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : TREE_TERMINATION_DEADLINE_MS;
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(() => terminate(child)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`whole-tree termination did not settle within ${boundedMs}ms`)),
					boundedMs
				);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

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

import { spawn } from 'node:child_process';
import { FLEET_MACHINE_OPERATION_MAX_MS } from '@ever-works/contracts';
import { machineChildEnv } from './exec';

/**
 * Machine facts (FL-09 P2) — a child whose output is read LINE BY LINE while
 * it runs: `docker pull`, `docker run` (which may pull first) and
 * `docker image prune` report progress as they go, and the machine family
 * turns that into `operation.progress` on channel 0 (CONTRACTS §3.3).
 *
 * Same rules as every machine-facts child (`exec.ts`): argv, `shell: false`,
 * the scrubbed environment (plus, for a run, the container's variables —
 * which travel ONLY through the environment, never the command line, FR-29),
 * and a hard deadline (CONTRACTS §10: 60 minutes). The abort signal (the
 * platform's `operation.cancel`, or the channel closing) kills it.
 */

export interface StreamRunOptions {
	/** Extra environment merged over the scrubbed one (a run's `-e NAME` values). */
	extraEnv?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
	/** Each line of stdout and stderr, without its newline. */
	onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
	timeoutMs?: number;
}

export interface StreamRunResult {
	code: number | null;
	/** The last lines (at most 200) of each stream, for the result and the error hint. */
	stdoutTail: string[];
	stderrTail: string[];
	spawnError?: string;
	timedOut: boolean;
	aborted: boolean;
}

export type StreamRunner = (command: string, args: readonly string[], options?: StreamRunOptions) => Promise<StreamRunResult>;

const TAIL_LINES = 200;
const MAX_LINE = 2_000;

export function createStreamRunner(baseEnv: NodeJS.ProcessEnv = machineChildEnv()): StreamRunner {
	return (command, args, options = {}) =>
		new Promise<StreamRunResult>((resolve) => {
			const env: NodeJS.ProcessEnv = { ...baseEnv, ...(options.extraEnv ?? {}) };
			const stdoutTail: string[] = [];
			const stderrTail: string[] = [];
			let timedOut = false;
			let aborted = false;
			let settled = false;
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(command, [...args], { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
			} catch (error) {
				resolve({
					code: 1,
					stdoutTail,
					stderrTail: [error instanceof Error ? error.message : String(error)],
					spawnError: (error as NodeJS.ErrnoException)?.code ?? 'ESPAWN',
					timedOut,
					aborted
				});
				return;
			}
			const finish = (result: Omit<StreamRunResult, 'stdoutTail' | 'stderrTail' | 'timedOut' | 'aborted'>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', onAbort);
				resolve({ ...result, stdoutTail, stderrTail, timedOut, aborted });
			};
			const kill = () => {
				try {
					child.kill('SIGTERM');
					setTimeout(() => {
						if (!settled) child.kill('SIGKILL');
					}, 5_000).unref?.();
				} catch {
					// already gone
				}
			};
			const onAbort = () => {
				aborted = true;
				kill();
			};
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, options.timeoutMs ?? FLEET_MACHINE_OPERATION_MAX_MS);
			timer.unref?.();
			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener('abort', onAbort, { once: true });

			const reader = (stream: 'stdout' | 'stderr', tail: string[]) => {
				let buffered = '';
				return (chunk: Buffer) => {
					buffered += chunk.toString('utf8');
					// Docker redraws progress with \r; treat it as a line end too.
					const parts = buffered.split(/\r\n|\n|\r/);
					buffered = parts.pop() ?? '';
					if (buffered.length > MAX_LINE) buffered = buffered.slice(-MAX_LINE);
					for (const raw of parts) {
						const line = raw.slice(0, MAX_LINE);
						if (!line.trim()) continue;
						tail.push(line);
						if (tail.length > TAIL_LINES) tail.shift();
						options.onLine?.(line, stream);
					}
				};
			};
			child.stdout?.on('data', reader('stdout', stdoutTail));
			child.stderr?.on('data', reader('stderr', stderrTail));
			child.on('error', (error: NodeJS.ErrnoException) => {
				stderrTail.push(error.message);
				finish({ code: 1, ...(error.code ? { spawnError: error.code } : {}) });
			});
			child.on('close', (code) => finish({ code: typeof code === 'number' ? code : null }));
		});
}

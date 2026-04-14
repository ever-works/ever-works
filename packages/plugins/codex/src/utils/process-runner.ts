import { spawn, type ChildProcess } from 'child_process';
import { buildSubprocessEnv } from './subprocess-env.js';

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
const KILL_TIMEOUT_MS = 5000;

export interface ExecuteOptions {
	readonly command?: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly model?: string;
	readonly bypassApprovalsAndSandbox?: boolean;
	readonly outputSchemaPath?: string;
	readonly outputLastMessagePath?: string;
	readonly signal?: AbortSignal;
	readonly onStdoutLine?: (line: string) => void;
	readonly onStderrLine?: (line: string) => void;
}

export interface ExecuteResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly killed: boolean;
	readonly duration: number;
}

export function executeCodex(options: ExecuteOptions): {
	promise: Promise<ExecuteResult>;
	kill: () => void;
} {
	let childProcess: ChildProcess | null = null;
	let killed = false;

	const kill = () => {
		if (!childProcess || killed) {
			return;
		}
		killed = true;
		childProcess.kill('SIGTERM');

		const killTimer = setTimeout(() => {
			if (childProcess && !childProcess.killed) {
				childProcess.kill('SIGKILL');
			}
		}, KILL_TIMEOUT_MS);

		childProcess.on('exit', () => {
			clearTimeout(killTimer);
		});
	};

	const promise = new Promise<ExecuteResult>((resolve, reject) => {
		const startTime = Date.now();

		const args = ['exec'];
		if (options.bypassApprovalsAndSandbox) {
			args.push('--dangerously-bypass-approvals-and-sandbox');
		} else {
			args.push('--full-auto');
		}
		args.push('--skip-git-repo-check');
		if (options.model) {
			args.push('--model', options.model);
		}
		if (options.outputSchemaPath) {
			args.push('--output-schema', options.outputSchemaPath);
		}
		if (options.outputLastMessagePath) {
			args.push('--output-last-message', options.outputLastMessagePath);
		}
		args.push(options.prompt);

		const env = buildSubprocessEnv(options.env);

		childProcess = spawn(options.command ?? 'codex', args, {
			cwd: options.cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';
		let stdoutRemainder = '';
		let stderrRemainder = '';

		childProcess.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf-8');
			if (stdout.length < MAX_BUFFER_SIZE) {
				stdout += text;
				if (stdout.length > MAX_BUFFER_SIZE) {
					stdout = stdout.slice(0, MAX_BUFFER_SIZE);
				}
			}

			if (options.onStdoutLine) {
				const combined = stdoutRemainder + text;
				const lines = combined.split('\n');
				stdoutRemainder = lines.pop() ?? '';
				for (const line of lines) {
					if (line.trim()) {
						options.onStdoutLine(line);
					}
				}
			}
		});

		childProcess.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf-8');
			if (stderr.length < MAX_BUFFER_SIZE) {
				stderr += text;
				if (stderr.length > MAX_BUFFER_SIZE) {
					stderr = stderr.slice(0, MAX_BUFFER_SIZE);
				}
			}

			if (options.onStderrLine) {
				const combined = stderrRemainder + text;
				const lines = combined.split('\n');
				stderrRemainder = lines.pop() ?? '';
				for (const line of lines) {
					if (line.trim()) {
						options.onStderrLine(line);
					}
				}
			}
		});

		childProcess.on('error', (error) => {
			reject(error);
		});

		childProcess.on('exit', (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code,
				killed,
				duration: Date.now() - startTime
			});
		});

		if (options.signal) {
			if (options.signal.aborted) {
				kill();
			} else {
				options.signal.addEventListener('abort', kill, { once: true });
			}
		}
	});

	return { promise, kill };
}

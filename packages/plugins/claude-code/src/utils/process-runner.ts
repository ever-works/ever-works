import { spawn, type ChildProcess } from 'child_process';
import { MAX_BUFFER_SIZE, KILL_TIMEOUT_MS } from '../types.js';

export interface ExecuteOptions {
	/** Path to the Claude Code binary */
	readonly binaryPath: string;
	/** User prompt (passed as -p argument) */
	readonly prompt: string;
	/** System prompt (passed as --append-system-prompt) */
	readonly systemPrompt: string;
	/** Working directory (workspace path) */
	readonly cwd: string;
	/** Environment variables to set */
	readonly env: Record<string, string>;
	/** Maximum agentic turns */
	readonly maxTurns: number;
	/** Maximum budget in USD (optional) */
	readonly maxBudgetUsd?: number;
	/** Abort signal for cancellation */
	readonly signal?: AbortSignal;
}

export interface ExecuteResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly killed: boolean;
	readonly duration: number;
}

/**
 * Execute Claude Code CLI as a child process.
 * Returns a promise for the result and a kill function for cancellation.
 */
export function executeClaudeCode(options: ExecuteOptions): {
	promise: Promise<ExecuteResult>;
	kill: () => void;
} {
	let childProcess: ChildProcess | null = null;
	let killed = false;

	const kill = () => {
		if (!childProcess || killed) return;
		killed = true;

		// Send SIGTERM first
		childProcess.kill('SIGTERM');

		// Force SIGKILL after timeout
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

		const args: string[] = [
			'-p',
			options.prompt,
			'--dangerously-skip-permissions',
			'--append-system-prompt',
			options.systemPrompt,
			'--no-session-persistence',
			'--max-turns',
			String(options.maxTurns)
		];

		if (options.maxBudgetUsd !== undefined) {
			args.push('--max-budget-usd', String(options.maxBudgetUsd));
		}

		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			...options.env,
			DISABLE_AUTOUPDATER: '1',
			DISABLE_TELEMETRY: '1'
		};

		childProcess = spawn(options.binaryPath, args, {
			cwd: options.cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';

		childProcess.stdout?.on('data', (chunk: Buffer) => {
			if (stdout.length < MAX_BUFFER_SIZE) {
				stdout += chunk.toString('utf-8');
				if (stdout.length > MAX_BUFFER_SIZE) {
					stdout = stdout.slice(0, MAX_BUFFER_SIZE);
				}
			}
		});

		childProcess.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length < MAX_BUFFER_SIZE) {
				stderr += chunk.toString('utf-8');
				if (stderr.length > MAX_BUFFER_SIZE) {
					stderr = stderr.slice(0, MAX_BUFFER_SIZE);
				}
			}
		});

		childProcess.on('error', (err) => {
			reject(err);
		});

		childProcess.on('exit', (code) => {
			const duration = Date.now() - startTime;
			resolve({
				stdout,
				stderr,
				exitCode: code,
				killed,
				duration
			});
		});

		// Handle abort signal
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

import { spawn, type ChildProcess } from 'child_process';
import { MAX_BUFFER_SIZE, KILL_TIMEOUT_MS } from '../types.js';
import { buildSubprocessEnv } from './subprocess-env.js';

export interface ExecuteOptions {
	/** Path to the Claude Code binary */
	readonly binaryPath: string;
	/** User prompt (passed as -p argument) */
	readonly prompt: string;
	/** System prompt (passed as --append-system-prompt) */
	readonly systemPrompt: string;
	/** Working work (workspace path) */
	readonly cwd: string;
	/** Environment variables to set */
	readonly env: Record<string, string>;
	/** Maximum agentic turns */
	readonly maxTurns: number;
	/** Maximum budget in USD (optional) */
	readonly maxBudgetUsd?: number;
	/** Model alias or full name (optional) */
	readonly model?: string;
	/** Abort signal for cancellation */
	readonly signal?: AbortSignal;
	/** Callback for each stdout line (enables stream-json output format) */
	readonly onStdoutLine?: (line: string) => void;
	/** Callback for each stderr line */
	readonly onStderrLine?: (line: string) => void;
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

		if (options.onStdoutLine) {
			args.push('--output-format', 'stream-json', '--verbose');
		}

		if (options.maxBudgetUsd !== undefined) {
			args.push('--max-budget-usd', String(options.maxBudgetUsd));
		}

		if (options.model) {
			args.push('--model', options.model);
		}

		// C-10: build the subprocess env from an explicit allow-list instead of
		// spreading `process.env`. The CLI runs with --dangerously-skip-permissions
		// and is fed user prompts + scraped web content + community-PR text — any
		// prompt-injection in those inputs can drive the model to `printenv` and
		// exfiltrate every host secret. Mirror the codex / gemini / opencode
		// pattern: only PATH/HOME/TMPDIR, proxy/CA vars, and ANTHROPIC_*/
		// CLAUDE_CODE_* keys are forwarded.
		const env: Record<string, string> = buildSubprocessEnv({
			...options.env,
			DISABLE_AUTOUPDATER: '1',
			DISABLE_TELEMETRY: '1'
		});

		childProcess = spawn(options.binaryPath, args, {
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

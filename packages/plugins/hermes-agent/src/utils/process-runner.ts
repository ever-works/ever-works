import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { KILL_TIMEOUT_MS, MAX_BUFFER_SIZE } from '../types.js';

const PASSTHROUGH_ENV_KEYS = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE'
] as const;

export interface ExecuteOptions {
	readonly binaryPath: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly profile: string;
	readonly toolsets: string;
	readonly provider?: string;
	readonly model?: string;
	readonly skills?: string;
	readonly maxTurns: number;
	readonly yolo: boolean;
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

export function buildHermesArgs(options: ExecuteOptions): string[] {
	const args = ['--profile', options.profile, 'chat', '--quiet', '--toolsets', options.toolsets];

	if (options.yolo) {
		args.push('--yolo');
	}

	if (options.provider) {
		args.push('--provider', options.provider);
	}

	if (options.model) {
		args.push('--model', options.model);
	}

	if (options.skills) {
		args.push('--skills', options.skills);
	}

	args.push('--max-turns', String(options.maxTurns), '--query', options.prompt);

	return args;
}

export function buildHermesEnv(cwd: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		TERMINAL_CWD: cwd
	};

	for (const key of PASSTHROUGH_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	return env;
}

export function executeHermes(options: ExecuteOptions): {
	promise: Promise<ExecuteResult>;
	kill: () => void;
} {
	let childProcess: ChildProcess | null = null;
	let killed = false;
	let abortListener: (() => void) | null = null;

	const kill = () => {
		if (!childProcess || killed) return;
		killed = true;
		childProcess.kill('SIGTERM');

		const killTimer = setTimeout(() => {
			if (childProcess && !childProcess.killed) {
				childProcess.kill('SIGKILL');
			}
		}, KILL_TIMEOUT_MS);

		childProcess.on('exit', () => clearTimeout(killTimer));
	};

	const promise = new Promise<ExecuteResult>((resolve, reject) => {
		const startTime = Date.now();
		const args = buildHermesArgs(options);

		childProcess = spawn(options.binaryPath, args, {
			cwd: options.cwd,
			env: buildHermesEnv(options.cwd),
			stdio: ['ignore', 'pipe', 'pipe']
		});

		const cleanupAbortListener = () => {
			if (options.signal && abortListener) {
				options.signal.removeEventListener('abort', abortListener);
				abortListener = null;
			}
		};

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

			const combined = stdoutRemainder + text;
			const lines = combined.split('\n');
			stdoutRemainder = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim()) {
					options.onStdoutLine?.(line);
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

			const combined = stderrRemainder + text;
			const lines = combined.split('\n');
			stderrRemainder = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim()) {
					options.onStderrLine?.(line);
				}
			}
		});

		childProcess.on('error', (error) => {
			cleanupAbortListener();
			reject(error);
		});
		childProcess.on('exit', (code) => {
			cleanupAbortListener();
			if (stdoutRemainder.trim()) {
				options.onStdoutLine?.(stdoutRemainder);
			}
			if (stderrRemainder.trim()) {
				options.onStderrLine?.(stderrRemainder);
			}

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
				abortListener = kill;
				options.signal.addEventListener('abort', abortListener, { once: true });
			}
		}
	});

	return { promise, kill };
}

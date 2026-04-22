import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { MAX_BUFFER_SIZE, KILL_TIMEOUT_MS } from '../types.js';

export interface ExecuteOptions {
	readonly binaryPath: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly model?: string;
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

export function executeOpenCode(options: ExecuteOptions): {
	promise: Promise<ExecuteResult>;
	kill: () => void;
} {
	let childProcess: ChildProcess | null = null;
	let killed = false;

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
		const args: string[] = ['run', '--format', 'json'];

		if (options.model) {
			args.push('--model', options.model);
		}

		args.push(options.prompt);

		const passthroughEnvKeys = [
			'HTTP_PROXY',
			'HTTPS_PROXY',
			'ALL_PROXY',
			'NO_PROXY',
			'SSL_CERT_FILE',
			'SSL_CERT_DIR',
			'NODE_EXTRA_CA_CERTS'
		] as const;

		const env: Record<string, string> = {
			PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
			HOME: process.env.HOME ?? os.homedir(),
			TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
			OPENCODE_DISABLE_AUTOUPDATE: '1'
		};
		for (const key of passthroughEnvKeys) {
			const value = process.env[key];
			if (value) {
				env[key] = value;
			}
		}
		Object.assign(env, options.env);

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

		childProcess.on('error', reject);
		childProcess.on('exit', (code) => {
			if (stdoutRemainder?.trim()) {
				options.onStdoutLine?.(stdoutRemainder);
			}
			if (stderrRemainder?.trim()) {
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
				options.signal.addEventListener('abort', kill, { once: true });
			}
		}
	});

	return { promise, kill };
}

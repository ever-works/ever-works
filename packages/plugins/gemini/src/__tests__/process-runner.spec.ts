import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { executeGemini } from '../utils/process-runner';

vi.mock('child_process', () => ({
	spawn: vi.fn()
}));

/**
 * Security regression test for the subprocess environment construction.
 *
 * The Gemini CLI authenticates with the scoped GEMINI_API_KEY passed via
 * options.env. Host GCP credentials must NOT be forwarded into the child
 * process, otherwise an untrusted generation run could act as the host's
 * GCP identity. Proxy / TLS-trust keys remain forwarded so corporate
 * network egress keeps working.
 */
describe('executeGemini - subprocess env passthrough', () => {
	function makeFakeChild() {
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill: () => void;
			killed: boolean;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		child.killed = false;
		return child;
	}

	const savedEnv: Record<string, string | undefined> = {};
	const TRACKED_KEYS = [
		'GOOGLE_APPLICATION_CREDENTIALS',
		'GOOGLE_API_USE_CLIENT_CERTIFICATE',
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'NODE_EXTRA_CA_CERTS'
	];

	beforeEach(() => {
		vi.mocked(spawn).mockReset();
		for (const key of TRACKED_KEYS) {
			savedEnv[key] = process.env[key];
		}
	});

	afterEach(() => {
		for (const key of TRACKED_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	function runAndCaptureEnv(): Record<string, string> {
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

		const { promise } = executeGemini({
			command: 'gemini',
			commandArgs: [],
			prompt: 'hello',
			systemPrompt: 'sys',
			cwd: '/tmp/work',
			env: { GEMINI_API_KEY: 'scoped-key' }
		});
		// Let the process "exit" so the promise settles and nothing leaks.
		child.emit('exit', 0);
		void promise;

		const call = vi.mocked(spawn).mock.calls[0];
		const opts = call[2] as { env: Record<string, string> };
		return opts.env;
	}

	it('does NOT forward host GCP credentials into the subprocess', () => {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = '/host/secret/gcp.json';
		process.env.GOOGLE_API_USE_CLIENT_CERTIFICATE = 'true';

		const env = runAndCaptureEnv();

		expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
		expect(env).not.toHaveProperty('GOOGLE_API_USE_CLIENT_CERTIFICATE');
		// The scoped per-run key is still passed through from options.env.
		expect(env.GEMINI_API_KEY).toBe('scoped-key');
	});

	it('still forwards proxy and TLS-trust env vars', () => {
		process.env.HTTP_PROXY = 'http://proxy.internal:3128';
		process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
		process.env.NODE_EXTRA_CA_CERTS = '/etc/ssl/corp-ca.pem';

		const env = runAndCaptureEnv();

		expect(env.HTTP_PROXY).toBe('http://proxy.internal:3128');
		expect(env.HTTPS_PROXY).toBe('http://proxy.internal:3128');
		expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp-ca.pem');
	});
});

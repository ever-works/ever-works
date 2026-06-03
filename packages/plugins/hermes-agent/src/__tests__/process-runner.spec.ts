import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
	spawn: vi.fn()
}));

import { spawn } from 'child_process';
import { buildHermesArgs, buildHermesEnv, executeHermes } from '../utils/process-runner.js';

function createMockChild(exitCode = 0): EventEmitter & {
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		killed: boolean;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killed = false;
	child.kill = vi.fn((signal?: string) => {
		child.killed = true;
		if (signal === 'SIGTERM' || signal === 'SIGKILL') {
			queueMicrotask(() => child.emit('exit', null));
		}
		return true;
	});

	queueMicrotask(() => {
		child.stdout.end();
		child.stderr.end();
		child.emit('exit', exitCode);
	});

	return child;
}

describe('process-runner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes Hermes profile selection with the supported short flag', () => {
		const args = buildHermesArgs({
			binaryPath: 'hermes',
			prompt: 'Return JSON',
			cwd: '/tmp/workspace',
			profile: 'everworks-test',
			toolsets: 'web',
			maxTurns: 10,
			yolo: true
		});

		expect(args.slice(0, 3)).toEqual(['-p', 'everworks-test', 'chat']);
	});

	it('removes the abort listener when Hermes exits naturally', async () => {
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, 'addEventListener');
		const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
		vi.mocked(spawn).mockReturnValueOnce(createMockChild(0) as never);

		const result = await executeHermes({
			binaryPath: 'hermes',
			prompt: 'Return JSON',
			cwd: '/tmp/workspace',
			profile: 'default',
			toolsets: 'web',
			maxTurns: 10,
			yolo: true,
			signal: controller.signal
		}).promise;

		expect(result.exitCode).toBe(0);
		expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('forwards proxy/TLS plumbing and Hermes-namespaced config but never host secrets', () => {
		process.env.DATABASE_URL = 'postgres://secret';
		process.env.HERMES_INFERENCE_PROVIDER = 'gemini';
		process.env.HTTP_PROXY = 'http://proxy.local';
		process.env.NODE_EXTRA_CA_CERTS = '/tmp/custom-ca.pem';

		const env = buildHermesEnv('/tmp/workspace');

		// Non-allowlisted host secrets must never reach the child.
		expect(env.DATABASE_URL).toBeUndefined();
		// Proxy / TLS plumbing and Hermes-prefixed config pass through.
		expect(env.HERMES_INFERENCE_PROVIDER).toBe('gemini');
		expect(env.HTTP_PROXY).toBe('http://proxy.local');
		expect(env.NODE_EXTRA_CA_CERTS).toBe('/tmp/custom-ca.pem');
		expect(env.TERMINAL_CWD).toBe('/tmp/workspace');

		delete process.env.DATABASE_URL;
		delete process.env.HERMES_INFERENCE_PROVIDER;
		delete process.env.HTTP_PROXY;
		delete process.env.NODE_EXTRA_CA_CERTS;
	});

	it('forwards ONLY the active provider credential, not the broad multi-provider key set', () => {
		process.env.OPENROUTER_API_KEY = 'sk-openrouter';
		process.env.OPENAI_API_KEY = 'sk-openai';
		process.env.GEMINI_API_KEY = 'sk-gemini';
		process.env.ANTHROPIC_API_KEY = 'sk-anthropic';
		process.env.NOUS_API_KEY = 'sk-nous';

		// Active provider is openrouter -> only OPENROUTER_API_KEY is exposed.
		const env = buildHermesEnv('/tmp/workspace', 'openrouter');

		expect(env.OPENROUTER_API_KEY).toBe('sk-openrouter');
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.GEMINI_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.NOUS_API_KEY).toBeUndefined();

		delete process.env.OPENROUTER_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.GEMINI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.NOUS_API_KEY;
	});

	it('forwards the provider base-URL override alongside its key when the provider needs one', () => {
		process.env.GEMINI_API_KEY = 'sk-gemini';
		process.env.GEMINI_BASE_URL = 'https://gemini.local';
		process.env.OPENAI_API_KEY = 'sk-openai';

		const env = buildHermesEnv('/tmp/workspace', 'gemini');

		expect(env.GEMINI_API_KEY).toBe('sk-gemini');
		expect(env.GEMINI_BASE_URL).toBe('https://gemini.local');
		// A different provider's key is still withheld.
		expect(env.OPENAI_API_KEY).toBeUndefined();

		delete process.env.GEMINI_API_KEY;
		delete process.env.GEMINI_BASE_URL;
		delete process.env.OPENAI_API_KEY;
	});

	it('resolves the active provider from HERMES_INFERENCE_PROVIDER when no explicit provider is passed', () => {
		process.env.HERMES_INFERENCE_PROVIDER = 'openai';
		process.env.OPENAI_API_KEY = 'sk-openai';
		process.env.OPENROUTER_API_KEY = 'sk-openrouter';

		const env = buildHermesEnv('/tmp/workspace');

		expect(env.OPENAI_API_KEY).toBe('sk-openai');
		expect(env.OPENROUTER_API_KEY).toBeUndefined();

		delete process.env.HERMES_INFERENCE_PROVIDER;
		delete process.env.OPENAI_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
	});

	it('forwards NO inference-provider credential when the provider cannot be identified', () => {
		// No --provider override and no HERMES_INFERENCE_PROVIDER => profile is the
		// source of truth; the plugin must not guess-and-leak any provider key.
		process.env.OPENAI_API_KEY = 'sk-openai';
		process.env.OPENROUTER_API_KEY = 'sk-openrouter';
		process.env.ANTHROPIC_API_KEY = 'sk-anthropic';

		const env = buildHermesEnv('/tmp/workspace');

		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.OPENROUTER_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();

		delete process.env.OPENAI_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
	});

	it('does not forward a provider key for an unknown provider name', () => {
		process.env.OPENAI_API_KEY = 'sk-openai';

		const env = buildHermesEnv('/tmp/workspace', 'totally-unknown-provider');

		expect(env.OPENAI_API_KEY).toBeUndefined();

		delete process.env.OPENAI_API_KEY;
	});
});

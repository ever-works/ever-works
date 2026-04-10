import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeCodex } from '../utils/process-runner.js';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args)
}));

class MockStream extends EventEmitter {
	emitData(value: string): void {
		this.emit('data', Buffer.from(value, 'utf-8'));
	}
}

class MockChildProcess extends EventEmitter {
	readonly stdout = new MockStream();
	readonly stderr = new MockStream();
	killed = false;
	kill = vi.fn((signal?: string) => {
		this.killed = true;
		this.emit('killed', signal);
		return true;
	});
}

describe('process-runner', () => {
	let child: MockChildProcess;

	beforeEach(() => {
		child = new MockChildProcess();
		spawnMock.mockReset();
		spawnMock.mockReturnValue(child);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('spawns codex with full-auto and model args', async () => {
		const run = executeCodex({
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: { OPENAI_API_KEY: 'sk-test' },
			model: 'codex-mini-latest'
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			['exec', '--full-auto', '--skip-git-repo-check', '--model', 'codex-mini-latest', 'Generate items'],
			expect.objectContaining({
				cwd: '/tmp/workspace',
				env: expect.objectContaining({ OPENAI_API_KEY: 'sk-test' }),
				stdio: ['ignore', 'pipe', 'pipe']
			})
		);

		child.emit('exit', 0);
		const result = await run.promise;
		expect(result.exitCode).toBe(0);
		expect(result.killed).toBe(false);
	});

	it('streams stdout and stderr lines to callbacks', async () => {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];

		const run = executeCodex({
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: {},
			onStdoutLine: (line) => stdoutLines.push(line),
			onStderrLine: (line) => stderrLines.push(line)
		});

		child.stdout.emitData('line one\nline');
		child.stdout.emitData(' two\n');
		child.stderr.emitData('warn one\nwarn two\n');
		child.emit('exit', 0);

		await run.promise;

		expect(stdoutLines).toEqual(['line one', 'line two']);
		expect(stderrLines).toEqual(['warn one', 'warn two']);
	});

	it('supports a custom codex command path', async () => {
		const run = executeCodex({
			command: '/usr/local/bin/codex',
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: {}
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'/usr/local/bin/codex',
			['exec', '--full-auto', '--skip-git-repo-check', 'Generate items'],
			expect.any(Object)
		);

		child.emit('exit', 0);
		await run.promise;
	});

	it('kills the child process when aborted', async () => {
		const controller = new AbortController();

		const run = executeCodex({
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: {},
			signal: controller.signal
		});

		controller.abort();
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');

		child.emit('exit', null);
		const result = await run.promise;
		expect(result.killed).toBe(true);
	});
});

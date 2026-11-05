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

	// Intentional spec change (models refresh 2026-11-05): this case used to pin `--full-auto`,
	// which `codex exec` removed in CLI 0.147.0 (openai/codex#36054). The documented successor
	// is `--sandbox workspace-write`; exec already defaults approvals to never.
	it('spawns codex with the workspace-write sandbox and model args', async () => {
		const run = executeCodex({
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: { OPENAI_API_KEY: 'sk-test' },
			model: 'codex-mini-latest'
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			[
				'exec',
				'--sandbox',
				'workspace-write',
				'--skip-git-repo-check',
				'--model',
				'codex-mini-latest',
				'--',
				'Generate items'
			],
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

	it('passes output schema and last-message paths when provided', async () => {
		const run = executeCodex({
			prompt: 'Return JSON items',
			cwd: '/tmp/workspace',
			env: {},
			outputSchemaPath: '/tmp/workspace/_meta/schema.json',
			outputLastMessagePath: '/tmp/workspace/_meta/output.json'
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			[
				'exec',
				'--sandbox',
				'workspace-write',
				'--skip-git-repo-check',
				'--output-schema',
				'/tmp/workspace/_meta/schema.json',
				'--output-last-message',
				'/tmp/workspace/_meta/output.json',
				'--',
				'Return JSON items'
			],
			expect.any(Object)
		);

		child.emit('exit', 0);
		await run.promise;
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
			['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--', 'Generate items'],
			expect.any(Object)
		);

		child.emit('exit', 0);
		await run.promise;
	});

	it('adds the dangerous bypass flag only when explicitly enabled', async () => {
		const run = executeCodex({
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: {},
			bypassApprovalsAndSandbox: true
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--', 'Generate items'],
			expect.any(Object)
		);

		child.emit('exit', 0);
		await run.promise;
	});

	it('never passes the removed --full-auto flag and keeps the sandbox off the bypass path', async () => {
		const sandboxed = executeCodex({ prompt: 'Generate items', cwd: '/tmp/workspace', env: {} });
		child.emit('exit', 0);
		await sandboxed.promise;

		const bypassChild = new MockChildProcess();
		spawnMock.mockReturnValueOnce(bypassChild);
		const bypassed = executeCodex({
			prompt: 'Generate items',
			cwd: '/tmp/workspace',
			env: {},
			bypassApprovalsAndSandbox: true
		});
		bypassChild.emit('exit', 0);
		await bypassed.promise;

		const sandboxedArgs = spawnMock.mock.calls[0][1] as string[];
		const bypassedArgs = spawnMock.mock.calls[1][1] as string[];
		expect(sandboxedArgs).not.toContain('--full-auto');
		expect(bypassedArgs).not.toContain('--full-auto');
		expect(sandboxedArgs.slice(1, 3)).toEqual(['--sandbox', 'workspace-write']);
		// `codex exec` rejects `-a never`; exec already defaults approvals to never.
		expect(sandboxedArgs).not.toContain('-a');
		expect(sandboxedArgs).not.toContain('--ask-for-approval');
		// The bypass flag already disables the sandbox, so `--sandbox` must not be combined with it.
		expect(bypassedArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(bypassedArgs).not.toContain('--sandbox');
	});

	it.each(['codex-mini-latest', 'gpt-5.4', 'gpt-5.2-codex'])(
		'passes a previously shipped model id (%s) to the CLI unchanged',
		async (model) => {
			const run = executeCodex({ prompt: 'Generate items', cwd: '/tmp/workspace', env: {}, model });
			child.emit('exit', 0);
			await run.promise;

			const args = spawnMock.mock.calls[0][1] as string[];
			expect(args[args.indexOf('--model') + 1]).toBe(model);
		}
	);

	it('passes the prompt after an end-of-options separator so a flag-like prompt is not parsed as an option', async () => {
		const run = executeCodex({
			prompt: '--help me build items',
			cwd: '/tmp/workspace',
			env: {}
		});

		const args = spawnMock.mock.calls[0][1] as string[];
		const promptIndex = args.indexOf('--help me build items');
		expect(promptIndex).toBeGreaterThan(0);
		// The prompt must be immediately preceded by the `--` end-of-options marker.
		expect(args[promptIndex - 1]).toBe('--');

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

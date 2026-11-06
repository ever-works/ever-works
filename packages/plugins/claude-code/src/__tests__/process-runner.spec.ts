import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args)
}));

import { executeClaudeCode } from '../utils/process-runner';

class MockChildProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;
	kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

async function runAndCaptureArgs(model?: string): Promise<string[]> {
	const child = new MockChildProcess();
	spawnMock.mockReturnValueOnce(child);
	const run = executeClaudeCode({
		binaryPath: '/tmp/claude-code-generator/bin/claude',
		prompt: 'Generate items',
		systemPrompt: 'system prompt',
		cwd: '/tmp/workspace',
		env: {},
		maxTurns: 10,
		model
	});
	child.emit('exit', 0);
	await run.promise;
	return spawnMock.mock.calls.at(-1)?.[1] as string[];
}

describe('claude-code process-runner (models refresh 2026-11-05)', () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it.each(['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'sonnet', 'claude-fable-5-1'])(
		'passes the saved model %s to --model unchanged',
		async (model) => {
			const args = await runAndCaptureArgs(model);
			expect(args[args.indexOf('--model') + 1]).toBe(model);
		}
	);

	it('omits --model when no model is set, so the CLI picks its own default', async () => {
		expect(await runAndCaptureArgs()).not.toContain('--model');
	});

	// CLI 2.1.302 starts `-p` sessions that name no permission mode in `default` mode on
	// third-party providers. This runner names one: `--dangerously-skip-permissions` is
	// documented as equivalent to `--permission-mode bypassPermissions`
	// (https://code.claude.com/docs/en/cli-reference, checked 2026-11-05).
	it('always names a permission mode for the -p session', async () => {
		const args = await runAndCaptureArgs('sonnet');
		expect(args[0]).toBe('-p');
		expect(args).toContain('--dangerously-skip-permissions');
	});
});

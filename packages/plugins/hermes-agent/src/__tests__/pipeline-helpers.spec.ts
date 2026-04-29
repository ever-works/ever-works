import { describe, expect, it, vi } from 'vitest';
import { buildHermesArgs } from '../utils/process-runner.js';
import { resolveHermesRuntimeSettings, resolveSettings } from '../utils/pipeline-helpers.js';

describe('resolveHermesRuntimeSettings', () => {
	it('applies defaults', () => {
		expect(resolveHermesRuntimeSettings({})).toMatchObject({
			profile: 'default',
			toolsets: 'web,terminal,skills',
			maxTurns: 90,
			yolo: true
		});
	});

	it('keeps explicit values', () => {
		expect(
			resolveHermesRuntimeSettings({
				profile: 'work',
				provider: 'openrouter',
				model: 'anthropic/claude-sonnet-4',
				toolsets: 'web,terminal',
				skills: 'research-pack',
				maxTurns: 12,
				yolo: false,
				binaryPath: '/usr/local/bin/hermes'
			})
		).toMatchObject({
			profile: 'work',
			provider: 'openrouter',
			model: 'anthropic/claude-sonnet-4',
			toolsets: 'web,terminal',
			skills: 'research-pack',
			maxTurns: 12,
			yolo: false,
			binaryPath: '/usr/local/bin/hermes'
		});
	});
});

describe('buildHermesArgs', () => {
	it('builds one-shot Hermes CLI arguments', () => {
		expect(
			buildHermesArgs({
				binaryPath: 'hermes',
				prompt: 'Return JSON',
				cwd: '/tmp/workspace',
				profile: 'work',
				toolsets: 'web,terminal',
				provider: 'openrouter',
				model: 'anthropic/claude-sonnet-4',
				skills: 'research-pack',
				maxTurns: 12,
				yolo: true
			})
		).toEqual([
			'-p',
			'work',
			'chat',
			'--quiet',
			'--toolsets',
			'web,terminal',
			'--yolo',
			'--provider',
			'openrouter',
			'--model',
			'anthropic/claude-sonnet-4',
			'--skills',
			'research-pack',
			'--max-turns',
			'12',
			'--query',
			'Return JSON'
		]);
	});
});

describe('resolveSettings', () => {
	it('merges global, user, then directory settings by precedence', async () => {
		const context = {
			getSettings: vi.fn(async (scope: 'global' | 'user' | 'directory') => {
				if (scope === 'global') {
					return {
						model: 'global-model',
						binaryPath: '/usr/bin/hermes',
						toolsets: 'web'
					};
				}

				if (scope === 'user') {
					return {
						model: 'user-model',
						profile: 'work'
					};
				}

				return {
					model: 'directory-model',
					maxTurns: 25
				};
			})
		};

		await expect(resolveSettings(context as never, 'user-1', 'dir-1')).resolves.toEqual({
			model: 'directory-model',
			binaryPath: '/usr/bin/hermes',
			toolsets: 'web',
			profile: 'work',
			maxTurns: 25
		});
	});
});

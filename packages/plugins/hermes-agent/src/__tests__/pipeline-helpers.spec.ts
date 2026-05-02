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
	it('merges global, user, then work settings by actual source precedence', async () => {
		const context = {
			getResolvedSettings: vi.fn(async (scope: 'global' | 'user' | 'work') => {
				if (scope === 'global') {
					return {
						model: { value: 'global-model', source: 'default' },
						binaryPath: { value: '/usr/bin/hermes', source: 'default' },
						toolsets: { value: 'web', source: 'default' },
						profile: { value: 'default', source: 'default' }
					};
				}

				if (scope === 'user') {
					return {
						model: { value: 'user-model', source: 'user' },
						profile: { value: 'work', source: 'user' }
					};
				}

				return {
					model: { value: 'work-model', source: 'work' },
					maxTurns: { value: 25, source: 'work' },
					profile: { value: 'default', source: 'default' }
				};
			})
		};

		await expect(resolveSettings(context as never, 'user-1', 'dir-1')).resolves.toEqual({
			model: 'work-model',
			binaryPath: '/usr/bin/hermes',
			toolsets: 'web',
			profile: 'work',
			maxTurns: 25
		});
	});

	it('keeps user and work settings when global settings lookup fails', async () => {
		const context = {
			getResolvedSettings: vi.fn(async (scope: 'global' | 'user' | 'work') => {
				if (scope === 'global') {
					throw new Error('global settings unavailable');
				}

				if (scope === 'user') {
					return {
						profile: { value: 'everworks-test', source: 'user' },
						model: { value: 'user-model', source: 'user' }
					};
				}

				return {
					maxTurns: { value: 25, source: 'work' }
				};
			})
		};

		await expect(resolveSettings(context as never, 'user-1', 'dir-1')).resolves.toEqual({
			profile: 'everworks-test',
			model: 'user-model',
			maxTurns: 25
		});
	});

	it('does not let work fallback values override explicit user settings', async () => {
		const context = {
			getResolvedSettings: vi.fn(async (scope: 'global' | 'user' | 'work') => {
				if (scope === 'global') {
					return {
						profile: { value: 'default', source: 'default' }
					};
				}

				if (scope === 'user') {
					return {
						profile: { value: 'everworks-test', source: 'user' }
					};
				}

				return {
					profile: { value: 'default', source: 'default' }
				};
			})
		};

		await expect(resolveSettings(context as never, 'user-1', 'dir-1')).resolves.toEqual({
			profile: 'everworks-test'
		});
	});
});

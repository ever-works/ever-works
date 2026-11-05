import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateSettingsConstraints, type PluginSettingsSchemaProperty } from '@ever-works/plugin/api';

const { requestMock, sentPayloads } = vi.hoisted(() => ({
	requestMock: vi.fn(),
	sentPayloads: [] as Array<{ url: string; body: Record<string, unknown> }>
}));

vi.mock('https', () => {
	const mocked = { request: requestMock };
	return { ...mocked, default: mocked };
});

import { ClaudeCodePlugin } from '../claude-code.plugin';
import { DEFAULT_CLI_VERSION } from '../types';

/**
 * Models refresh (2026-11-05). Sources:
 * https://code.claude.com/docs/en/model-config (CLI aliases),
 * https://platform.claude.com/docs/en/about-claude/models/overview and
 * https://platform.claude.com/docs/en/about-claude/model-deprecations (API ids).
 */

// Copied from packages/agent/src/works-config/services/works-config-import-applier.service.ts
// (SAFE_PIPELINE_MODEL_PATTERN). A works-config import rejects any pipeline model id outside it.
const SAFE_PIPELINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const CURRENT_IDS = [
	'sonnet',
	'opus',
	'haiku',
	'claude-opus-5-5',
	'claude-sonnet-5-5',
	'claude-haiku-5-5',
	'claude-fable-5-1'
];
const LEGACY_IDS = ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

/** Fakes `https.request` for the Messages API probe and records each JSON body it was sent. */
function answerProbesWith(statusCode: number): void {
	requestMock.mockImplementation((url: string, _options: unknown, onResponse: (res: unknown) => void) => {
		let body = '';
		return {
			setTimeout: vi.fn(),
			on: vi.fn(),
			destroy: vi.fn(),
			write: (chunk: string) => {
				body += chunk;
			},
			end: () => {
				sentPayloads.push({ url, body: JSON.parse(body) as Record<string, unknown> });
				onResponse({ statusCode, resume: vi.fn() });
			}
		};
	});
}

describe('claude-code model catalog (models refresh 2026-11-05)', () => {
	const plugin = new ClaudeCodePlugin();

	beforeEach(() => {
		requestMock.mockReset();
		sentPayloads.length = 0;
	});

	it('lists the CLI aliases, the current full ids and the still-served legacy ids', async () => {
		const models = await plugin.listModels();
		expect(models.map((m) => m.id)).toEqual([...CURRENT_IDS, ...LEGACY_IDS]);
	});

	it('gives the aliases and the 5.x ids a 1M context and 128K output, and 4.5 ids 200K / 64K', async () => {
		const models = await plugin.listModels();
		for (const id of CURRENT_IDS) {
			const model = models.find((m) => m.id === id);
			expect(model?.capabilities.maxContextLength, id).toBe(1_000_000);
			expect(model?.capabilities.maxOutputTokens, id).toBe(128_000);
		}
		for (const id of LEGACY_IDS) {
			const model = models.find((m) => m.id === id);
			expect(model?.capabilities.maxContextLength, id).toBe(200_000);
			expect(model?.capabilities.maxOutputTokens, id).toBe(64_000);
		}
	});

	it('says which model each alias resolves to on the Anthropic API', async () => {
		const models = await plugin.listModels();
		expect(models.find((m) => m.id === 'opus')?.description).toContain('Opus 5.5');
		expect(models.find((m) => m.id === 'sonnet')?.description).toContain('Sonnet 5.5');
		expect(models.find((m) => m.id === 'haiku')?.description).toContain('Haiku 5.5');
	});

	it('marks the legacy ids and drops the retired Opus 4.1 snapshot from the list', async () => {
		const models = await plugin.listModels();
		expect(models.find((m) => m.id === 'claude-sonnet-4-5-20250929')?.name).toContain(
			'(legacy, retires 2026-11-30)'
		);
		expect(models.find((m) => m.id === 'claude-haiku-4-5-20251001')?.name).toContain('(legacy)');
		// Retired 2026-08-05 (D2). Still accepted and passed through unchanged (see below); Anthropic
		// rejects it at run time.
		expect(models.map((m) => m.id)).not.toContain('claude-opus-4-1-20250805');
	});

	it('lists Fable 5.1 as a premium frontier model and never a claude-mythos id', async () => {
		const models = await plugin.listModels();
		expect(models.find((m) => m.id === 'claude-fable-5-1')?.description).toMatch(/premium/i);
		expect(models.some((m) => m.id.startsWith('claude-mythos'))).toBe(false);
	});

	it('keeps every listed id inside the works-config pipeline model pattern', async () => {
		for (const model of await plugin.listModels()) {
			expect(model.id, model.id).toMatch(SAFE_PIPELINE_MODEL_PATTERN);
		}
	});

	it('keeps the sonnet alias as the default, inside the list', async () => {
		const modelField = plugin.settingsSchema.properties?.model;
		expect(modelField?.default).toBe('sonnet');
		expect((await plugin.listModels()).map((m) => m.id)).toContain(modelField?.default);
		expect(modelField?.enum).toBeUndefined();
	});

	it('uses a current full id as the example in the model description', () => {
		const description = String(plugin.settingsSchema.properties?.model?.description);
		expect(description).toContain('claude-sonnet-5-5');
		expect(description).not.toContain('claude-sonnet-4-5-20250929');
	});

	it('pins the Claude Code CLI to the npm stable release 2.1.311', () => {
		expect(DEFAULT_CLI_VERSION).toBe('2.1.311');
	});

	// Retired ids are still accepted and passed through unchanged; the vendor rejects them at run time.
	describe('previously shipped ids are still accepted and passed through unchanged', () => {
		it.each(['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-haiku-4-5-20251001'])(
			'%s passes settings validation',
			(model) => {
				const properties = plugin.settingsSchema.properties as Record<string, PluginSettingsSchemaProperty>;
				expect(validateSettingsConstraints({ model }, properties)).toEqual([]);
			}
		);
	});

	describe('API-key probe sends an API model id, never a CLI alias (D3)', () => {
		it('probes Sonnet 5.5 when no model is saved', async () => {
			answerProbesWith(200);

			const result = await plugin.validateConnection({ apiKey: 'sk-ant-test' });

			expect(result.success).toBe(true);
			expect(sentPayloads).toHaveLength(1);
			expect(sentPayloads[0].url).toBe('https://api.anthropic.com/v1/messages');
			expect(sentPayloads[0].body.model).toBe('claude-sonnet-5-5');
		});

		it('probes Sonnet 5.5 from isAvailable when no model is saved', async () => {
			answerProbesWith(200);

			await expect(plugin.isAvailable({ apiKey: 'sk-ant-test' })).resolves.toBe(true);
			expect(sentPayloads[0].body.model).toBe('claude-sonnet-5-5');
		});

		it.each([
			// Claude Code docs: for Anthropic API users the `default` model is Opus 5.5.
			['default', 'claude-opus-5-5'],
			['sonnet', 'claude-sonnet-5-5'],
			['opus', 'claude-opus-5-5'],
			['haiku', 'claude-haiku-5-5'],
			['fable', 'claude-fable-5-1'],
			['best', 'claude-opus-5-5'],
			['opusplan', 'claude-opus-5-5'],
			['sonnet[1m]', 'claude-sonnet-5-5'],
			['opus[1m]', 'claude-opus-5-5'],
			['claude-sonnet-5-5[1m]', 'claude-sonnet-5-5'],
			['claude-opus-5-5', 'claude-opus-5-5'],
			['claude-fable-5-1', 'claude-fable-5-1'],
			['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'],
			['claude-opus-4-1-20250805', 'claude-opus-4-1-20250805']
		])('a saved %s is probed as %s', async (saved, probed) => {
			answerProbesWith(200);

			await plugin.validateConnection({ apiKey: 'sk-ant-test', model: saved });

			expect(sentPayloads[0].body.model).toBe(probed);
		});

		// Opus 5.5 and Fable 5.1 always think, and thinking counts toward max_tokens. The API has no
		// minimum max_tokens: a response that hits the cap ends with stop_reason "max_tokens" (HTTP
		// 200), which is all this key check reads. So the probe stays at 8 tokens and sends no
		// `thinking` field (Fable 5.1 and Opus 5.5 reject thinking "disabled" with a 400).
		// https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting (2026-11-06)
		it('keeps the probe small and leaves thinking at the model default', async () => {
			answerProbesWith(200);

			await plugin.validateConnection({ apiKey: 'sk-ant-test', model: 'fable' });

			expect(sentPayloads[0].body.max_tokens).toBe(8);
			expect(sentPayloads[0].body).not.toHaveProperty('thinking');
		});

		it('sends no temperature (API version 2026-10-21 removed it)', async () => {
			answerProbesWith(200);

			await plugin.validateConnection({ apiKey: 'sk-ant-test', model: 'opus' });

			expect(sentPayloads[0].body).not.toHaveProperty('temperature');
			expect(sentPayloads[0].body).not.toHaveProperty('top_p');
			expect(sentPayloads[0].body).not.toHaveProperty('top_k');
		});

		it('still reports an invalid key as a failed validation', async () => {
			answerProbesWith(401);

			const result = await plugin.validateConnection({ apiKey: 'sk-ant-bad' });

			expect(result.success).toBe(false);
		});
	});
});

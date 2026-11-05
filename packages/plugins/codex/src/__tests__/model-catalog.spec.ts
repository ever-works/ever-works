import { describe, expect, it } from 'vitest';

import { validateSettingsConstraints, type PluginSettingsSchemaProperty } from '@ever-works/plugin/api';

import { CodexPlugin } from '../codex.plugin.js';
import { DEFAULT_CLI_VERSION, DEFAULT_MODEL } from '../types.js';

/**
 * Models refresh (2026-11-05). Pins the Codex model catalog to the ids Codex offers today:
 * https://learn.chatgpt.com/docs/models, https://developers.openai.com/api/docs/models and
 * https://developers.openai.com/api/docs/deprecations.
 */

// Copied from packages/agent/src/works-config/services/works-config-import-applier.service.ts
// (SAFE_PIPELINE_MODEL_PATTERN). A works-config import rejects any pipeline model id outside it.
const SAFE_PIPELINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const CURRENT_IDS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];
const LEGACY_IDS = ['gpt-5.4'];

describe('codex model catalog (models refresh 2026-11-05)', () => {
	const plugin = new CodexPlugin();

	it('lists exactly the current Codex models, then the still-served legacy id', async () => {
		const models = await plugin.listModels();
		expect(models.map((m) => m.id)).toEqual([...CURRENT_IDS, ...LEGACY_IDS]);
	});

	it('gives every current model the 1,050,000-token context and 128,000-token output', async () => {
		const models = await plugin.listModels();
		for (const id of CURRENT_IDS) {
			const model = models.find((m) => m.id === id);
			expect(model?.capabilities.maxContextLength, id).toBe(1_050_000);
			expect(model?.capabilities.maxOutputTokens, id).toBe(128_000);
		}
	});

	it('labels gpt-5.4 as legacy and drops the vendor-retired ids from the list', async () => {
		const models = await plugin.listModels();
		expect(models.find((m) => m.id === 'gpt-5.4')?.name).toContain('(legacy)');
		const ids = models.map((m) => m.id);
		// Retired 2026-02-12 and 2026-07-23. Still accepted and passed through unchanged (see below);
		// OpenAI rejects them at run time.
		expect(ids).not.toContain('codex-mini-latest');
		expect(ids).not.toContain('gpt-5.2-codex');
	});

	it('keeps every listed id inside the works-config pipeline model pattern', async () => {
		const models = await plugin.listModels();
		for (const model of models) {
			expect(model.id, model.id).toMatch(SAFE_PIPELINE_MODEL_PATTERN);
		}
	});

	it('defaults to gpt-6.1-sol, which is in the list and is the schema default', async () => {
		expect(DEFAULT_MODEL).toBe('gpt-6.1-sol');
		const ids = (await plugin.listModels()).map((m) => m.id);
		expect(ids).toContain(DEFAULT_MODEL);
		expect(plugin.settingsSchema.properties?.model?.default).toBe(DEFAULT_MODEL);
	});

	it('describes the model field as plan-dependent and open to custom ids, with no enum', () => {
		const modelField = plugin.settingsSchema.properties?.model;
		expect(modelField?.enum).toBeUndefined();
		expect(String(modelField?.description)).toMatch(/sign-in|plan/i);
		expect(String(modelField?.description)).toMatch(/custom/i);
	});

	it('pins the Codex CLI to rust-v0.166.0', () => {
		expect(DEFAULT_CLI_VERSION).toBe('0.166.0');
	});

	// Retired ids are still accepted and passed through unchanged; the vendor rejects them at run time.
	describe('previously shipped ids are still accepted and passed through unchanged', () => {
		it.each(['codex-mini-latest', 'gpt-5.4', 'gpt-5.2-codex'])('%s passes settings validation', (model) => {
			expect(plugin.validateSettings({ model }).valid).toBe(true);
			const properties = plugin.settingsSchema.properties as Record<string, PluginSettingsSchemaProperty>;
			expect(validateSettingsConstraints({ model }, properties)).toEqual([]);
		});
	});
});

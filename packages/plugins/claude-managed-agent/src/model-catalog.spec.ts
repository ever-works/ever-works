import { describe, expect, it } from 'vitest';

import { validateSettingsConstraints, type PluginSettingsSchemaProperty } from '@ever-works/plugin/api';

import { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';
import { CLAUDE_MANAGED_AGENT_SUPPORTED_MODELS, DEFAULT_MODEL } from './types.js';

/**
 * Models refresh (2026-11-05). Source for the supported ids:
 * https://platform.claude.com/docs/en/managed-agents/agent-setup; limits and status from
 * https://platform.claude.com/docs/en/about-claude/models/overview and
 * https://platform.claude.com/docs/en/about-claude/model-deprecations.
 */

// Copied from packages/agent/src/works-config/services/works-config-import-applier.service.ts
// (SAFE_PIPELINE_MODEL_PATTERN). A works-config import rejects any pipeline model id outside it.
const SAFE_PIPELINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const NEW_IDS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const PREVIOUS_IDS = [
	'claude-opus-4-7',
	'claude-opus-4-6',
	'claude-sonnet-4-6',
	'claude-sonnet-4-5-20250929',
	'claude-haiku-4-5',
	'claude-haiku-4-5-20251001'
];

function model(id: string) {
	return CLAUDE_MANAGED_AGENT_SUPPORTED_MODELS.find((m) => m.id === id);
}

describe('claude-managed-agent model catalog (models refresh 2026-11-05)', () => {
	const plugin = new ClaudeManagedAgentPlugin();

	it('lists the current Claude models first and keeps every previously listed id', async () => {
		const ids = (await plugin.listModels()).map((m) => m.id);
		expect(ids).toEqual([...NEW_IDS, ...PREVIOUS_IDS]);
	});

	it('gives the 4.6+ models a 1M context and 128K output', () => {
		for (const id of [...NEW_IDS, 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
			expect(model(id)?.capabilities.maxContextLength, id).toBe(1_000_000);
			expect(model(id)?.capabilities.maxOutputTokens, id).toBe(128_000);
		}
	});

	it('gives the 4.5 models a 200K context and 64K output', () => {
		for (const id of ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
			expect(model(id)?.capabilities.maxContextLength, id).toBe(200_000);
			expect(model(id)?.capabilities.maxOutputTokens, id).toBe(64_000);
		}
	});

	it('marks every previous-generation id as legacy, with the Sonnet 4.5 retirement date', () => {
		for (const id of PREVIOUS_IDS) {
			expect(model(id)?.name, id).toContain('(legacy');
		}
		expect(model('claude-sonnet-4-5-20250929')?.name).toContain('(legacy, retires 2026-11-30)');
		for (const id of NEW_IDS) {
			expect(model(id)?.name, id).not.toContain('legacy');
		}
	});

	it('no longer calls Opus 4.7 the most capable generally available model', () => {
		expect(model('claude-opus-4-7')?.description).not.toMatch(/most capable/i);
	});

	it('lists Fable 5.1 as a premium frontier model and never a claude-mythos id', async () => {
		expect(model('claude-fable-5-1')?.description).toMatch(/premium/i);
		expect((await plugin.listModels()).some((m) => m.id.startsWith('claude-mythos'))).toBe(false);
	});

	it('keeps every listed id inside the works-config pipeline model pattern', async () => {
		for (const entry of await plugin.listModels()) {
			expect(entry.id, entry.id).toMatch(SAFE_PIPELINE_MODEL_PATTERN);
		}
	});

	it('defaults to claude-sonnet-5-5, which is in the list and is the schema default', async () => {
		expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
		expect((await plugin.listModels()).map((m) => m.id)).toContain(DEFAULT_MODEL);
		expect(plugin.settingsSchema.properties?.model?.default).toBe(DEFAULT_MODEL);
		expect(plugin.settingsSchema.properties?.model?.enum).toBeUndefined();
	});

	it.each(['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-opus-4-8'])(
		'accepts %s through settings validation (no enum on the model field)',
		(id) => {
			const properties = plugin.settingsSchema.properties as Record<string, PluginSettingsSchemaProperty>;
			expect(validateSettingsConstraints({ model: id }, properties)).toEqual([]);
		}
	);
});

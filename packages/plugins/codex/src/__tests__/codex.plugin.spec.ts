import { CodexPlugin } from '../codex.plugin.js';

describe('CodexPlugin', () => {
	it('exposes the expected plugin identity', () => {
		const plugin = new CodexPlugin();

		expect(plugin.id).toBe('codex');
		expect(plugin.category).toBe('pipeline');
		expect(plugin.capabilities).toContain('pipeline');
		expect(plugin.capabilities).toContain('form-schema-provider');
	});

	it('returns step definitions', () => {
		const plugin = new CodexPlugin();

		expect(plugin.getStepDefinitions()).toHaveLength(6);
		expect(plugin.getStepDefinitions()[0]?.id).toBe('setup-codex');
	});
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStatsSinkPlugin, STATS_SINK_CAPABILITY } from '@ever-works/plugin';
import { EverStatsSinkPlugin, EVER_STATS_SINK_PLUGIN_ID } from '../ever-stats-sink.plugin.js';

/**
 * The manifest the platform discovers and the class it instantiates agree,
 * and the plugin is the hidden, always-on system sender the module selects by
 * default — never something a person enables, configures or sees in a list.
 */
describe('ever-stats-sink manifest', () => {
	const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
		name: string;
		license: string;
		everworks: { plugin: Record<string, unknown> };
	};
	const manifest = pkg.everworks.plugin;

	it('declares the stats-sink capability as a hidden core system plugin', () => {
		expect(manifest).toMatchObject({
			id: EVER_STATS_SINK_PLUGIN_ID,
			category: 'integration',
			capabilities: [STATS_SINK_CAPABILITY],
			builtIn: true,
			autoEnable: true,
			systemPlugin: true,
			visibility: 'hidden',
			distribution: 'core',
			license: 'AGPL-3.0'
		});
		expect(pkg.license).toBe('AGPL-3.0');
	});

	it('matches the class the platform instantiates', () => {
		const plugin = new EverStatsSinkPlugin();
		expect(plugin.id).toBe(manifest.id);
		expect(plugin.version).toBe(manifest.version);
		expect(plugin.category).toBe(manifest.category);
		expect([...plugin.capabilities]).toEqual(manifest.capabilities);
		expect(isStatsSinkPlugin(plugin)).toBe(true);
	});

	it('has no setting at all: no secret, no URL, nothing a person could leak through it', () => {
		const plugin = new EverStatsSinkPlugin();
		expect(plugin.settingsSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
	});
});

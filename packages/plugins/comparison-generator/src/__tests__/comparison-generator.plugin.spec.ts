import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComparisonGeneratorPlugin } from '../comparison-generator.plugin.js';
import type { PluginContext } from '@ever-works/plugin';

const buildContext = (): PluginContext =>
	({
		pluginId: 'comparison-generator',
		logger: {
			log: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		},
		getSettings: vi.fn().mockResolvedValue({})
	}) as unknown as PluginContext;

describe('ComparisonGeneratorPlugin', () => {
	let plugin: ComparisonGeneratorPlugin;

	beforeEach(() => {
		plugin = new ComparisonGeneratorPlugin();
	});

	describe('metadata', () => {
		it('exposes stable identity fields', () => {
			expect(plugin.id).toBe('comparison-generator');
			expect(plugin.name).toBe('Comparison Generator');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('utility');
		});

		it('declares no operational capabilities (utility plugin)', () => {
			expect(plugin.capabilities).toEqual([]);
		});

		it('uses hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('settingsSchema', () => {
		it('exposes cadence_override enum with sensible default', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.cadence_override.enum).toEqual(['use_work', 'daily', 'weekly', 'monthly']);
			expect(props.cadence_override.default).toBe('use_work');
		});

		it('exposes max_comparisons_mode and conditional max_comparisons bounds', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.max_comparisons_mode.enum).toEqual(['custom', 'unlimited']);
			expect(props.max_comparisons_mode.default).toBe('custom');
			expect(props.max_comparisons.default).toBe(50);
			expect(props.max_comparisons.minimum).toBe(1);
			expect(props.max_comparisons.maximum).toBe(500);
			expect(props.max_comparisons['x-showIf']).toEqual({
				field: 'max_comparisons_mode',
				value: 'custom'
			});
		});

		it('exposes min_items_for_comparison bounds', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.min_items_for_comparison.default).toBe(3);
			expect(props.min_items_for_comparison.minimum).toBe(2);
			expect(props.min_items_for_comparison.maximum).toBe(20);
		});

		it('marks AI overrides and custom_prompt + extended_analysis as hidden', () => {
			const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
			expect(props.ai_provider['x-hidden']).toBe(true);
			expect(props.ai_model['x-hidden']).toBe(true);
			expect(props.custom_prompt['x-hidden']).toBe(true);
			expect(props.extended_analysis['x-hidden']).toBe(true);
			expect(props.extended_analysis.default).toBe(false);
		});
	});

	describe('lifecycle', () => {
		it('logs on load', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Comparison Generator plugin loaded');
		});

		it('clears context on unload', async () => {
			const ctx = buildContext();
			await plugin.onLoad(ctx);
			await expect(plugin.onUnload()).resolves.toBeUndefined();
		});
	});

	describe('healthCheck', () => {
		it('reports healthy with a checkedAt timestamp', async () => {
			const h = await plugin.healthCheck();
			expect(h.status).toBe('healthy');
			expect(h.message).toMatch(/ready/i);
			expect(typeof h.checkedAt).toBe('number');
		});
	});

	describe('manifest', () => {
		it('returns a manifest aligned with plugin metadata', () => {
			const m = plugin.getManifest();
			expect(m.id).toBe('comparison-generator');
			expect(m.category).toBe('utility');
			expect(m.builtIn).toBe(true);
			expect(m.systemPlugin).toBe(true);
			expect(m.autoEnable).toBe(false);
			expect(m.visibility).toBe('public');
		});

		it('includes a non-empty readme', () => {
			const m = plugin.getManifest();
			expect(typeof m.readme).toBe('string');
			expect((m.readme as string).length).toBeGreaterThan(100);
		});
	});
});

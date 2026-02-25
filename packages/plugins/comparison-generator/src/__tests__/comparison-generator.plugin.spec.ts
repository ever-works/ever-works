import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComparisonGeneratorPlugin } from '../comparison-generator.plugin.js';
import { DEFAULT_COMPARISON_SETTINGS } from '../types.js';
import type { PluginContext } from '@ever-works/plugin';

describe('ComparisonGeneratorPlugin', () => {
	let plugin: ComparisonGeneratorPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new ComparisonGeneratorPlugin();
	});

	const createMockContext = (): PluginContext =>
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

	describe('metadata', () => {
		it('should have correct id, name, and version', () => {
			expect(plugin.id).toBe('comparison-generator');
			expect(plugin.name).toBe('Comparison Generator');
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have utility category', () => {
			expect(plugin.category).toBe('utility');
		});

		it('should have form-schema-provider capability', () => {
			expect(plugin.capabilities).toContain('form-schema-provider');
		});

		it('should have admin-only configuration mode', () => {
			expect(plugin.configurationMode).toBe('admin-only');
		});
	});

	describe('settingsSchema', () => {
		it('should be an object schema', () => {
			expect(plugin.settingsSchema.type).toBe('object');
		});

		it('should have 4 properties', () => {
			const props = plugin.settingsSchema.properties!;
			expect(Object.keys(props)).toHaveLength(4);
			expect(props).toHaveProperty('cadence_override');
			expect(props).toHaveProperty('max_comparisons_mode');
			expect(props).toHaveProperty('max_comparisons');
			expect(props).toHaveProperty('min_items_for_comparison');
		});

		it('should have title and description on every property', () => {
			const props = plugin.settingsSchema.properties!;
			for (const [key, prop] of Object.entries(props)) {
				expect((prop as any).title, `${key} should have a title`).toBeDefined();
				expect((prop as any).description, `${key} should have a description`).toBeDefined();
			}
		});
	});

	describe('lifecycle hooks', () => {
		it('should store context and log on load', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);
			expect(ctx.logger.log).toHaveBeenCalledWith('Comparison Generator plugin loaded');
		});

		it('should clear context on unload', async () => {
			const ctx = createMockContext();
			await plugin.onLoad(ctx);
			await plugin.onUnload();
			// No throw — unload succeeds even after load
		});
	});

	describe('validateSettings', () => {
		it('should accept empty settings as valid', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(true);
		});

		it('should reject max_comparisons of 0', async () => {
			const result = await plugin.validateSettings({ max_comparisons: 0 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('max_comparisons');
		});

		it('should reject max_comparisons of 501', async () => {
			const result = await plugin.validateSettings({ max_comparisons: 501 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('max_comparisons');
		});

		it('should reject max_comparisons of NaN', async () => {
			const result = await plugin.validateSettings({ max_comparisons: 'abc' });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('max_comparisons');
		});

		it('should reject min_items_for_comparison of 1', async () => {
			const result = await plugin.validateSettings({ min_items_for_comparison: 1 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('min_items_for_comparison');
		});

		it('should reject min_items_for_comparison of 21', async () => {
			const result = await plugin.validateSettings({ min_items_for_comparison: 21 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('min_items_for_comparison');
		});

		it('should reject invalid cadence_override', async () => {
			const result = await plugin.validateSettings({ cadence_override: 'hourly' });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('cadence_override');
		});

		it('should accept valid cadence_override values', async () => {
			for (const cadence of ['use_directory', 'daily', 'weekly', 'monthly']) {
				const result = await plugin.validateSettings({ cadence_override: cadence });
				expect(result.valid).toBe(true);
			}
		});

		it('should reject invalid max_comparisons_mode', async () => {
			const result = await plugin.validateSettings({ max_comparisons_mode: 'invalid' });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('max_comparisons_mode');
		});

		it('should accept valid max_comparisons_mode values', async () => {
			for (const mode of ['custom', 'unlimited']) {
				const result = await plugin.validateSettings({ max_comparisons_mode: mode });
				expect(result.valid).toBe(true);
			}
		});

		it('should skip max_comparisons validation when mode is unlimited', async () => {
			const result = await plugin.validateSettings({ max_comparisons_mode: 'unlimited', max_comparisons: 0 });
			expect(result.valid).toBe(true);
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBeDefined();
			expect(typeof health.checkedAt).toBe('number');
		});
	});

	describe('getFormFields', () => {
		it('should return 4 fields', () => {
			const fields = plugin.getFormFields();
			expect(fields).toHaveLength(4);
		});

		it('should return comparison_enabled, comparison_cadence, comparison_max_mode, comparison_max', () => {
			const fields = plugin.getFormFields();
			const names = fields.map((f) => f.name);
			expect(names).toContain('comparison_enabled');
			expect(names).toContain('comparison_cadence');
			expect(names).toContain('comparison_max_mode');
			expect(names).toContain('comparison_max');
		});

		it('should assign all fields to comparisons group', () => {
			const fields = plugin.getFormFields();
			for (const field of fields) {
				expect(field.group).toBe('comparisons');
			}
		});
	});

	describe('getFormGroups', () => {
		it('should return 1 group named comparisons', () => {
			const groups = plugin.getFormGroups();
			expect(groups).toHaveLength(1);
			expect(groups[0].name).toBe('comparisons');
		});

		it('should be collapsible', () => {
			const groups = plugin.getFormGroups();
			expect(groups[0].collapsible).toBe(true);
		});
	});

	describe('validateFormInput', () => {
		it('should accept empty input as valid', () => {
			const result = plugin.validateFormInput({});
			expect(result.valid).toBe(true);
		});

		it('should reject invalid comparison_max', () => {
			const result = plugin.validateFormInput({ comparison_max: 0 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('comparison_max');
		});

		it('should accept valid comparison_max', () => {
			const result = plugin.validateFormInput({ comparison_max: 100 });
			expect(result.valid).toBe(true);
		});

		it('should skip comparison_max validation when mode is unlimited', () => {
			const result = plugin.validateFormInput({ comparison_max_mode: 'unlimited', comparison_max: 0 });
			expect(result.valid).toBe(true);
		});
	});

	describe('getDefaultValues', () => {
		it('should match DEFAULT_COMPARISON_SETTINGS', () => {
			const defaults = plugin.getDefaultValues();
			expect(defaults.comparison_enabled).toBe(false);
			expect(defaults.comparison_cadence).toBe(DEFAULT_COMPARISON_SETTINGS.cadence_override);
			expect(defaults.comparison_max_mode).toBe(DEFAULT_COMPARISON_SETTINGS.max_comparisons_mode);
			expect(defaults.comparison_max).toBe(DEFAULT_COMPARISON_SETTINGS.max_comparisons);
		});
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApifyDataSourcePlugin } from '../apify-data-source.plugin.js';
import type { PluginContext } from '@ever-works/plugin';

describe('ApifyDataSourcePlugin', () => {
	let plugin: ApifyDataSourcePlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new ApifyDataSourcePlugin();
		mockContext = {
			pluginId: 'apify-data-source',
			logger: {
				log: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn()
			},
			cache: {} as any,
			http: {} as any,
			env: {} as any,
			envVars: {} as any,
			services: {} as any,
			getSettings: vi.fn(),
			getResolvedSettings: vi.fn(),
			onEvent: vi.fn(),
			emitEvent: vi.fn(),
			registerCustomCapability: vi.fn(),
			getCustomCapability: vi.fn(),
			hasCustomCapability: vi.fn(),
			listCustomCapabilities: vi.fn()
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Plugin Metadata', () => {
		it('should have correct plugin metadata', () => {
			expect(plugin.id).toBe('apify-data-source');
			expect(plugin.name).toBe('Apify Data Source');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('data-source');
		});

		it('should have both data-source and form-schema-provider capabilities', () => {
			expect(plugin.capabilities).toContain('data-source');
			expect(plugin.capabilities).toContain('form-schema-provider');
		});

		it('should NOT be a system plugin', () => {
			expect(plugin.systemPlugin).toBe(false);
		});

		it('should have source name "Apify"', () => {
			expect(plugin.sourceName).toBe('Apify');
		});
	});

	describe('IFormSchemaProvider - getFormFields', () => {
		it('should return form field definitions', () => {
			const fields = plugin.getFormFields();
			expect(Array.isArray(fields)).toBe(true);
			expect(fields.length).toBeGreaterThan(0);
		});

		it('should include the "enabled" checkbox field', () => {
			const fields = plugin.getFormFields();
			const enabledField = fields.find((f) => f.name === 'apify_enabled');

			expect(enabledField).toBeDefined();
			expect(enabledField?.type).toBe('boolean');
			expect(enabledField?.defaultValue).toBe(false);
		});

		it('should include datasetId field with showIf condition', () => {
			const fields = plugin.getFormFields();
			const datasetField = fields.find((f) => f.name === 'apify_datasetId');

			expect(datasetField).toBeDefined();
			expect(datasetField?.type).toBe('text');
			expect(datasetField?.showIf).toEqual({
				field: 'apify_enabled',
				operator: 'eq',
				value: true
			});
		});

		it('should include maxItems field', () => {
			const fields = plugin.getFormFields();
			const maxItemsField = fields.find((f) => f.name === 'apify_maxItems');

			expect(maxItemsField).toBeDefined();
			expect(maxItemsField?.type).toBe('number');
			expect(maxItemsField?.defaultValue).toBe(100);
		});
	});

	describe('IFormSchemaProvider - getFormGroups', () => {
		it('should return form field groups', () => {
			const groups = plugin.getFormGroups();
			expect(Array.isArray(groups)).toBe(true);
			expect(groups.length).toBeGreaterThan(0);
		});

		it('should have apify-data-source group', () => {
			const groups = plugin.getFormGroups();
			const apifyGroup = groups.find((g) => g.name === 'apify-data-source');

			expect(apifyGroup).toBeDefined();
			expect(apifyGroup?.title).toBe('Apify Data Source');
			expect(apifyGroup?.collapsible).toBe(true);
		});
	});

	describe('IFormSchemaProvider - validateFormInput', () => {
		it('should pass validation when disabled', () => {
			const result = plugin.validateFormInput({ apify_enabled: false });
			expect(result.valid).toBe(true);
		});

		it('should fail when enabled but no dataset ID provided', () => {
			const result = plugin.validateFormInput({
				apify_enabled: true,
				apify_datasetId: '',
				apify_actorRunId: ''
			});
			expect(result.valid).toBe(false);
			expect(result.errors?.[0]?.path).toBe('apify_datasetId');
		});

		it('should pass when enabled with dataset ID', () => {
			const result = plugin.validateFormInput({
				apify_enabled: true,
				apify_datasetId: 'abc123'
			});
			expect(result.valid).toBe(true);
		});

		it('should pass when enabled with actor run ID', () => {
			const result = plugin.validateFormInput({
				apify_enabled: true,
				apify_actorRunId: 'run123'
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('IFormSchemaProvider - transformFormValues', () => {
		it('should transform form values to pluginConfig structure', () => {
			const values = {
				apify_enabled: true,
				apify_datasetId: 'dataset123',
				apify_maxItems: 50,
				apify_filterByRelevance: true
			};

			const transformed = plugin.transformFormValues(values);

			expect(transformed['apify-data-source']).toEqual({
				enabled: true,
				datasetId: 'dataset123',
				actorRunId: undefined,
				maxItems: 50,
				filterByRelevance: true
			});
		});
	});

	describe('IDataSourcePlugin - query', () => {
		it('should return empty result when API token not configured', async () => {
			await plugin.onLoad(mockContext);

			const result = await plugin.query({
				settings: { datasetId: 'test' }
			});

			expect(result.items).toEqual([]);
			expect(mockContext.logger.error).toHaveBeenCalledWith('Apify API token not configured');
		});

		it('should return empty result when no dataset ID provided', async () => {
			await plugin.onLoad(mockContext);

			const result = await plugin.query({
				settings: { apiToken: 'test-token' }
			});

			expect(result.items).toEqual([]);
			expect(mockContext.logger.error).toHaveBeenCalledWith('No Apify dataset ID or actor run ID provided');
		});
	});

	describe('IDataSourcePlugin - getMetadata', () => {
		it('should return data source metadata', async () => {
			const metadata = await plugin.getMetadata();

			expect(metadata.name).toBe('Apify');
			expect(metadata.description).toBeDefined();
		});
	});

	describe('IDataSourcePlugin - isAvailable', () => {
		it('should return true', async () => {
			const available = await plugin.isAvailable();
			expect(available).toBe(true);
		});
	});

	describe('Lifecycle', () => {
		it('should log on load', async () => {
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Apify Data Source Plugin loaded');
		});

		it('should log on enable', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onEnable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Apify Data Source Plugin enabled');
		});

		it('should log on disable', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onDisable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Apify Data Source Plugin disabled');
		});
	});

	describe('getManifest', () => {
		it('should return correct manifest', () => {
			const manifest = plugin.getManifest();

			expect(manifest.id).toBe('apify-data-source');
			expect(manifest.name).toBe('Apify Data Source');
			expect(manifest.systemPlugin).toBe(false);
			expect(manifest.autoInstall).toBe(false);
			expect(manifest.capabilities).toContain('data-source');
			expect(manifest.capabilities).toContain('form-schema-provider');
		});
	});
});

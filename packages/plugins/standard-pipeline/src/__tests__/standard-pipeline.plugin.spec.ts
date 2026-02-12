import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StandardPipelinePlugin } from '../standard-pipeline.plugin';
import type { PluginContext, FormFieldDefinition, FormFieldGroup } from '@ever-works/plugin';

describe('StandardPipelinePlugin', () => {
	let plugin: StandardPipelinePlugin;

	beforeEach(() => {
		plugin = new StandardPipelinePlugin();
	});

	describe('Plugin Properties', () => {
		it('should have correct id', () => {
			expect(plugin.id).toBe('standard-pipeline');
		});

		it('should have correct name', () => {
			expect(plugin.name).toBe('Standard Pipeline');
		});

		it('should have correct version', () => {
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have correct category', () => {
			expect(plugin.category).toBe('pipeline');
		});

		it('should include pipeline capability', () => {
			expect(plugin.capabilities).toContain('pipeline');
		});

		it('should include form-schema-provider capability', () => {
			expect(plugin.capabilities).toContain('form-schema-provider');
		});

		it('should be marked as system plugin', () => {
			expect(plugin.systemPlugin).toBe(true);
		});
	});

	describe('IFormSchemaProvider Implementation', () => {
		describe('getFormFields', () => {
			it('should return an array of form field definitions', () => {
				const fields = plugin.getFormFields();
				expect(Array.isArray(fields)).toBe(true);
				expect(fields.length).toBeGreaterThan(0);
			});

			it('should include source_urls field', () => {
				const fields = plugin.getFormFields();
				const sourceUrlsField = fields.find((f) => f.name === 'source_urls');
				expect(sourceUrlsField).toBeDefined();
				expect(sourceUrlsField?.type).toBe('tags');
				expect(sourceUrlsField?.group).toBe('sources');
			});

			it('should include search configuration fields', () => {
				const fields = plugin.getFormFields();
				const searchFields = fields.filter((f) => f.group === 'search');
				expect(searchFields.length).toBeGreaterThan(0);

				const maxSearchQueries = searchFields.find((f) => f.name === 'max_search_queries');
				expect(maxSearchQueries).toBeDefined();
				expect(maxSearchQueries?.type).toBe('number');
				expect(maxSearchQueries?.defaultValue).toBe(10);
			});

			it('should include feature toggle fields', () => {
				const fields = plugin.getFormFields();
				const featureFields = fields.filter((f) => f.group === 'features');
				expect(featureFields.length).toBeGreaterThan(0);

				const generateCategories = featureFields.find((f) => f.name === 'generate_categories');
				expect(generateCategories).toBeDefined();
				expect(generateCategories?.type).toBe('boolean');
				expect(generateCategories?.defaultValue).toBe(true);
			});

			it('should include volume control fields', () => {
				const fields = plugin.getFormFields();
				const volumeFields = fields.filter((f) => f.group === 'volume');
				expect(volumeFields.length).toBeGreaterThan(0);

				const dataVolumeMode = volumeFields.find((f) => f.name === 'data_volume_mode');
				expect(dataVolumeMode).toBeDefined();
				expect(dataVolumeMode?.type).toBe('select');
				expect(dataVolumeMode?.options).toBeDefined();
			});

			it('should include advanced settings fields', () => {
				const fields = plugin.getFormFields();
				const advancedFields = fields.filter((f) => f.group === 'advanced');
				expect(advancedFields.length).toBeGreaterThan(0);
			});

			it('should include category hint fields', () => {
				const fields = plugin.getFormFields();
				const categoryFields = fields.filter((f) => f.group === 'categories');
				expect(categoryFields.length).toBeGreaterThan(0);

				const initialCategories = categoryFields.find((f) => f.name === 'initial_categories');
				expect(initialCategories).toBeDefined();
				expect(initialCategories?.type).toBe('tags');
			});

			it('should have numeric fields with validation', () => {
				const fields = plugin.getFormFields();
				const numericFields = fields.filter((f) => f.type === 'number');

				for (const field of numericFields) {
					if (field.validation) {
						expect(typeof field.validation.min).toBe('number');
						expect(typeof field.validation.max).toBe('number');
						expect(field.validation.min).toBeLessThanOrEqual(field.validation.max);
					}
				}
			});

			it('should have conditional field showIf for relevance_threshold_content', () => {
				const fields = plugin.getFormFields();
				const relevanceField = fields.find((f) => f.name === 'relevance_threshold_content');
				expect(relevanceField?.showIf).toBeDefined();
				expect(relevanceField?.showIf?.field).toBe('content_filtering_enabled');
				expect(relevanceField?.showIf?.operator).toBe('eq');
				expect(relevanceField?.showIf?.value).toBe(true);
			});
		});

		describe('getFormGroups', () => {
			it('should return an array of form field groups', () => {
				const groups = plugin.getFormGroups();
				expect(Array.isArray(groups)).toBe(true);
				expect(groups.length).toBeGreaterThan(0);
			});

			it('should have groups in correct order', () => {
				const groups = plugin.getFormGroups();
				const orders = groups.map((g) => g.order);
				expect(orders).toEqual([...orders].sort((a, b) => a - b));
			});

			it('should include required group properties', () => {
				const groups = plugin.getFormGroups();
				for (const group of groups) {
					expect(group.name).toBeDefined();
					expect(group.title).toBeDefined();
					expect(typeof group.order).toBe('number');
				}
			});

			it('should have some collapsible groups', () => {
				const groups = plugin.getFormGroups();
				const collapsibleGroups = groups.filter((g) => g.collapsible);
				expect(collapsibleGroups.length).toBeGreaterThan(0);
			});

			it('should have advanced groups collapsed by default', () => {
				const groups = plugin.getFormGroups();
				const advancedGroup = groups.find((g) => g.name === 'advanced');
				expect(advancedGroup?.collapsible).toBe(true);
				expect(advancedGroup?.collapsed).toBe(true);
			});
		});

		describe('validateFormInput', () => {
			it('should validate valid input successfully', () => {
				const result = plugin.validateFormInput({
					max_search_queries: 10,
					max_results_per_query: 5,
					data_volume_mode: 'real'
				});
				expect(result.valid).toBe(true);
				expect(result.errors).toBeUndefined();
			});

			it('should reject invalid numeric values', () => {
				const result = plugin.validateFormInput({
					max_search_queries: -5
				});
				expect(result.valid).toBe(false);
				expect(result.errors).toBeDefined();
				expect(result.errors?.length).toBeGreaterThan(0);
			});

			it('should reject values above maximum', () => {
				const result = plugin.validateFormInput({
					max_search_queries: 500 // Max is 100
				});
				expect(result.valid).toBe(false);
			});

			it('should validate URL arrays', () => {
				const result = plugin.validateFormInput({
					source_urls: ['https://example.com', 'https://test.com']
				});
				expect(result.valid).toBe(true);
			});

			it('should reject invalid URLs', () => {
				const result = plugin.validateFormInput({
					source_urls: ['not-a-valid-url']
				});
				expect(result.valid).toBe(false);
			});

			it('should validate data_volume_mode enum', () => {
				const validResult = plugin.validateFormInput({
					data_volume_mode: 'sample'
				});
				expect(validResult.valid).toBe(true);

				const invalidResult = plugin.validateFormInput({
					data_volume_mode: 'invalid_value'
				});
				expect(invalidResult.valid).toBe(false);
			});

			it('should allow empty/undefined values', () => {
				const result = plugin.validateFormInput({});
				expect(result.valid).toBe(true);
			});

			it('should validate threshold values between 0 and 1', () => {
				const validResult = plugin.validateFormInput({
					relevance_threshold_content: 0.5
				});
				expect(validResult.valid).toBe(true);

				const invalidResult = plugin.validateFormInput({
					relevance_threshold_content: 1.5
				});
				expect(invalidResult.valid).toBe(false);
			});
		});

		describe('getDefaultValues', () => {
			it('should return default values for fields with defaults', () => {
				const defaults = plugin.getDefaultValues();
				expect(defaults).toBeDefined();
				expect(typeof defaults).toBe('object');
			});

			it('should include default value for max_search_queries', () => {
				const defaults = plugin.getDefaultValues();
				expect(defaults.max_search_queries).toBe(10);
			});

			it('should include default value for generate_categories', () => {
				const defaults = plugin.getDefaultValues();
				expect(defaults.generate_categories).toBe(true);
			});

			it('should include default value for data_volume_mode', () => {
				const defaults = plugin.getDefaultValues();
				expect(defaults.data_volume_mode).toBe('real');
			});
		});

		describe('transformFormValues', () => {
			it('should transform data_volume_mode to uppercase', () => {
				const transformed = plugin.transformFormValues({
					data_volume_mode: 'real'
				});
				expect(transformed.data_volume_mode).toBe('REAL');
			});

			it('should remove empty arrays', () => {
				const transformed = plugin.transformFormValues({
					source_urls: [],
					initial_categories: ['test']
				});
				expect(transformed.source_urls).toBeUndefined();
				expect(transformed.initial_categories).toEqual(['test']);
			});

			it('should preserve non-empty values', () => {
				const transformed = plugin.transformFormValues({
					max_search_queries: 20,
					source_urls: ['https://example.com']
				});
				expect(transformed.max_search_queries).toBe(20);
				expect(transformed.source_urls).toEqual(['https://example.com']);
			});
		});

		describe('handledConfigFields', () => {
			it('should handle all config fields', () => {
				expect(plugin.handledConfigFields).toBeDefined();
				expect(plugin.handledConfigFields).toContain('*');
			});
		});
	});

	describe('Step Definitions', () => {
		describe('getStepDefinitions', () => {
			it('should return all step definitions', () => {
				const steps = plugin.getStepDefinitions();
				expect(Array.isArray(steps)).toBe(true);
				expect(steps.length).toBeGreaterThan(0);
			});

			it('should have 15 built-in steps', () => {
				const steps = plugin.getStepDefinitions();
				expect(steps.length).toBe(15);
			});

			it('should have unique step IDs', () => {
				const steps = plugin.getStepDefinitions();
				const ids = steps.map((s) => s.id);
				const uniqueIds = [...new Set(ids)];
				expect(ids.length).toBe(uniqueIds.length);
			});

			it('should have all required step properties', () => {
				const steps = plugin.getStepDefinitions();
				for (const step of steps) {
					expect(step.id).toBeDefined();
					expect(step.name).toBeDefined();
					expect(step.position).toBeDefined();
					// Position has a type field (first, after, before, last, order)
					expect(step.position.type).toBeDefined();
				}
			});
		});

		describe('getStepDefinition', () => {
			it('should return a step definition when called without argument', () => {
				const step = plugin.getStepDefinition();
				expect(step).toBeDefined();
				expect(step?.id).toBeDefined();
			});

			it('should return a specific step when called with stepId', () => {
				const step = plugin.getStepDefinition('web-search');
				expect(step).toBeDefined();
				expect(step?.id).toBe('web-search');
			});

			it('should return undefined for unknown stepId', () => {
				const step = plugin.getStepDefinition('unknown-step');
				expect(step).toBeUndefined();
			});
		});

		describe('Instance Methods', () => {
			it('isValidStepId should identify built-in steps', () => {
				expect(plugin.isValidStepId('web-search')).toBe(true);
				expect(plugin.isValidStepId('items-extraction')).toBe(true);
				expect(plugin.isValidStepId('unknown-step')).toBe(false);
			});

			it('getStepDefinition should return step by ID', () => {
				const step = plugin.getStepDefinition('web-search');
				expect(step).toBeDefined();
				expect(step?.id).toBe('web-search');
			});
		});
	});

	describe('Plugin Lifecycle', () => {
		it('should have onLoad method', () => {
			expect(typeof plugin.onLoad).toBe('function');
		});

		it('should have onUnload method', () => {
			expect(typeof plugin.onUnload).toBe('function');
		});

		it('should have validateSettings method', () => {
			expect(typeof plugin.validateSettings).toBe('function');
		});

		it('validateSettings should return valid for empty settings', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(true);
		});
	});

	describe('Health Check', () => {
		it('should return health check result', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBeDefined();
			expect(health.message).toBeDefined();
			expect(health.checkedAt).toBeDefined();
		});

		it('should report degraded status before onLoad', async () => {
			// Before onLoad is called, step executors are not registered
			const health = await plugin.healthCheck();
			// Without calling onLoad, no executors are registered
			expect(health.status).toBe('degraded');
		});

		it('should report healthy status after onLoad', async () => {
			// Create a mock context for onLoad
			const mockContext = {
				pluginId: 'standard-pipeline',
				logger: {
					log: vi.fn(),
					debug: vi.fn(),
					warn: vi.fn(),
					error: vi.fn()
				},
				cache: {
					get: vi.fn().mockResolvedValue(undefined),
					set: vi.fn().mockResolvedValue(undefined),
					delete: vi.fn().mockResolvedValue(false),
					has: vi.fn().mockResolvedValue(false),
					clear: vi.fn().mockResolvedValue(undefined)
				},
				http: {
					get: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: null }),
					post: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: null }),
					put: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: null }),
					patch: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: null }),
					delete: vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: null })
				},
				env: {
					platform: 'ever-works',
					platformVersion: '1.0.0',
					nodeVersion: process.version,
					isDevelopment: true,
					isProduction: false,
					isTest: true,
					tempDir: '/tmp',
					dataDir: '/tmp/plugins/standard-pipeline',
					features: new Set<string>()
				},
				envVars: {
					get: vi.fn().mockReturnValue(undefined),
					getOrDefault: vi.fn().mockImplementation((_key: string, defaultValue: string) => defaultValue),
					has: vi.fn().mockReturnValue(false),
					getRequired: vi.fn().mockImplementation((key: string) => {
						throw new Error(`Required env var ${key} not set`);
					})
				},
				services: {},
				getSettings: vi.fn().mockResolvedValue({}),
				getResolvedSettings: vi.fn().mockResolvedValue({}),
				onEvent: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
				emitEvent: vi.fn(),
				registerCustomCapability: vi.fn(),
				getCustomCapability: vi.fn().mockReturnValue(undefined),
				hasCustomCapability: vi.fn().mockReturnValue(false),
				listCustomCapabilities: vi.fn().mockReturnValue([])
			};

			// Create a fresh plugin and call onLoad
			const freshPlugin = new StandardPipelinePlugin();
			await freshPlugin.onLoad(mockContext as unknown as PluginContext);

			const health = await freshPlugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toContain('15');
		});
	});

	describe('Manifest', () => {
		it('should return valid manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('standard-pipeline');
			expect(manifest.name).toBe('Standard Pipeline');
			expect(manifest.version).toBe('1.0.0');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.capabilities).toContain('pipeline');
			expect(manifest.capabilities).toContain('form-schema-provider');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.systemPlugin).toBe(true);
		});

		it('should declare defaultForCapabilities', () => {
			const manifest = plugin.getManifest();
			expect(manifest.defaultForCapabilities).toContain('pipeline');
		});

		it('should declare selectableProviderCategories', () => {
			const manifest = plugin.getManifest();
			expect(manifest.selectableProviderCategories).toEqual(
				expect.arrayContaining(['ai-provider', 'search', 'screenshot', 'content-extractor'])
			);
		});

		it('should have public visibility', () => {
			const manifest = plugin.getManifest();
			expect(manifest.visibility).toBe('public');
		});
	});
});

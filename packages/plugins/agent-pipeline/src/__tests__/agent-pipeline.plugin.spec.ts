import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPipelinePlugin } from '../agent-pipeline.plugin';
import type { PluginContext, DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

describe('AgentPipelinePlugin', () => {
	let plugin: AgentPipelinePlugin;

	beforeEach(() => {
		plugin = new AgentPipelinePlugin();
	});

	describe('plugin metadata', () => {
		it('should have correct id', () => {
			expect(plugin.id).toBe('agent-pipeline');
		});

		it('should have correct name', () => {
			expect(plugin.name).toBe('Agent Pipeline');
		});

		it('should have pipeline category', () => {
			expect(plugin.category).toBe('pipeline');
		});

		it('should have pipeline and form-schema-provider capabilities', () => {
			expect(plugin.capabilities).toContain('pipeline');
			expect(plugin.capabilities).toContain('form-schema-provider');
		});
	});

	describe('onLoad', () => {
		it('should store context and log', async () => {
			const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			const context = {
				logger,
				getSettings: vi.fn().mockResolvedValue({})
			} as unknown as PluginContext;

			await plugin.onLoad(context);

			expect(logger.log).toHaveBeenCalledWith('Agent Pipeline plugin loaded');
		});
	});

	describe('validateSettings', () => {
		it('should always return valid', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(true);
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();

			expect(health.status).toBe('healthy');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('getManifest', () => {
		it('should return complete manifest', () => {
			const manifest = plugin.getManifest();

			expect(manifest.id).toBe('agent-pipeline');
			expect(manifest.name).toBe('Agent Pipeline');
			expect(manifest.category).toBe('pipeline');
			expect(manifest.capabilities).toContain('pipeline');
			expect(manifest.capabilities).toContain('form-schema-provider');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.selectableProviderCategories).toContain('ai-provider');
			expect(manifest.selectableProviderCategories).toContain('search');
			expect(manifest.selectableProviderCategories).toContain('screenshot');
			expect(manifest.selectableProviderCategories).toContain('content-extractor');
			expect(manifest.selectableProviderCategories).toContain('data-source');
		});
	});

	describe('getStepDefinitions', () => {
		it('should return 5 step definitions', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps).toHaveLength(5);
		});

		it('should have steps in correct order', () => {
			const steps = plugin.getStepDefinitions();
			const ids = steps.map((s) => s.id);
			expect(ids).toEqual([
				'prepare-context',
				'generate-items',
				'collect-results',
				'capture-screenshots',
				'cleanup'
			]);
		});

		it('should have first and last positions', () => {
			const steps = plugin.getStepDefinitions();
			expect(steps[0].position.type).toBe('first');
			expect(steps[steps.length - 1].position.type).toBe('last');
		});

		it('should have capture-screenshots as optional', () => {
			const steps = plugin.getStepDefinitions();
			const screenshot = steps.find((s) => s.id === 'capture-screenshots');
			expect(screenshot).toBeDefined();
			expect(screenshot!.optional).toBe(true);
		});
	});

	describe('getFormFields', () => {
		it('should return form fields', () => {
			const fields = plugin.getFormFields();

			expect(fields.length).toBeGreaterThan(0);
		});

		it('should include source_urls field', () => {
			const fields = plugin.getFormFields();
			const sourceUrls = fields.find((f) => f.name === 'source_urls');

			expect(sourceUrls).toBeDefined();
			expect(sourceUrls!.type).toBe('tags');
			expect(sourceUrls!.group).toBe('sources');
		});

		it('should include max_items field', () => {
			const fields = plugin.getFormFields();
			const maxItems = fields.find((f) => f.name === 'max_items');

			expect(maxItems).toBeDefined();
			expect(maxItems!.type).toBe('number');
			expect(maxItems!.defaultValue).toBe(50);
		});

		it('should include capture_screenshots field', () => {
			const fields = plugin.getFormFields();
			const screenshots = fields.find((f) => f.name === 'capture_screenshots');

			expect(screenshots).toBeDefined();
			expect(screenshots!.type).toBe('boolean');
		});
	});

	describe('getFormGroups', () => {
		it('should return form groups', () => {
			const groups = plugin.getFormGroups!();

			expect(groups.length).toBeGreaterThan(0);
		});

		it('should include sources group', () => {
			const groups = plugin.getFormGroups!();
			const sources = groups.find((g) => g.name === 'sources');

			expect(sources).toBeDefined();
			expect(sources!.title).toBe('Data Sources');
		});

		it('should have groups ordered correctly', () => {
			const groups = plugin.getFormGroups!();
			const orders = groups.map((g) => g.order);

			for (let i = 1; i < orders.length; i++) {
				expect(orders[i]).toBeGreaterThan(orders[i - 1] as any);
			}
		});
	});

	describe('validateFormInput', () => {
		it('should validate valid input', () => {
			const result = plugin.validateFormInput({ max_items: 50 });
			expect(result.valid).toBe(true);
		});

		it('should reject invalid max_items', () => {
			const result = plugin.validateFormInput({ max_items: 0 });
			expect(result.valid).toBe(false);
		});

		it('should reject max_items over 500', () => {
			const result = plugin.validateFormInput({ max_items: 501 });
			expect(result.valid).toBe(false);
		});

		it('should reject invalid URLs in source_urls', () => {
			const result = plugin.validateFormInput({
				source_urls: ['not-a-url']
			});
			expect(result.valid).toBe(false);
		});

		it('should accept valid URLs in source_urls', () => {
			const result = plugin.validateFormInput({
				source_urls: ['https://example.com']
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('getDefaultValues', () => {
		it('should return defaults matching field definitions', () => {
			const defaults = plugin.getDefaultValues!();
			expect(defaults.max_items).toBe(50);
		});
	});

	describe('execute', () => {
		const directory: DirectoryReference = {
			id: 'dir1',
			name: 'AI Tools',
			slug: 'ai-tools',
			user: { id: 'user1' }
		};

		const request: GenerationRequest = {
			prompt: 'Generate AI tools'
		};

		const existing: ExistingItems = {
			items: [],
			categories: [],
			tags: []
		};

		it('should fail without execContext', async () => {
			const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			const context = {
				logger,
				getSettings: vi.fn().mockResolvedValue({})
			} as unknown as PluginContext;
			await plugin.onLoad(context);

			const result = await plugin.execute(directory, request, existing, {});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(String(result.error)).toContain('execContext');
		});

		it('should fail without user ID', async () => {
			const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			const context = {
				logger,
				getSettings: vi.fn().mockResolvedValue({})
			} as unknown as PluginContext;
			await plugin.onLoad(context);

			const dirNoUser: DirectoryReference = {
				id: 'dir1',
				name: 'AI Tools',
				slug: 'ai-tools'
			};

			const result = await plugin.execute(dirNoUser, request, existing, {
				execContext: {
					aiFacade: {} as never,
					searchFacade: {} as never,
					screenshotFacade: {} as never,
					contentExtractorFacade: {} as never,
					logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
					directory: dirNoUser
				}
			});

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain('User ID');
		});
	});

	describe('cancel', () => {
		it('should not throw when no execution in progress', async () => {
			await expect(plugin.cancel()).resolves.toBeUndefined();
		});
	});

	describe('getState', () => {
		it('should return null before execution', () => {
			expect(plugin.getState()).toBeNull();
		});
	});

	describe('settingsSchema', () => {
		it('should define maxSteps setting', () => {
			const schema = plugin.settingsSchema;
			expect(schema.properties).toBeDefined();
			expect((schema.properties as Record<string, { type: string }>).maxSteps).toBeDefined();
			expect((schema.properties as Record<string, { type: string }>).maxSteps.type).toBe('integer');
		});
	});

	describe('handledConfigFields', () => {
		it('should handle all config fields', () => {
			expect(plugin.handledConfigFields).toEqual(['*']);
		});
	});
});

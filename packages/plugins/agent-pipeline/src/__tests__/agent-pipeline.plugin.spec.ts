import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPipelinePlugin } from '../agent-pipeline.plugin';
import type {
	PluginContext,
	DirectoryReference,
	GenerationRequest,
	ExistingItems,
	MutableItemData
} from '@ever-works/plugin';

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

		it('should include features group', () => {
			const groups = plugin.getFormGroups!();
			const features = groups.find((g) => g.name === 'features');

			expect(features).toBeDefined();
			expect(features!.title).toBe('Generation Features');
		});
	});

	describe('validateFormInput', () => {
		it('should return valid for empty input', () => {
			const result = plugin.validateFormInput({});
			expect(result.valid).toBe(true);
		});

		it('should return valid for correct values', () => {
			const result = plugin.validateFormInput({ target_items: 50, max_pages_to_process: 10 });
			expect(result.valid).toBe(true);
		});

		it('should reject target_items out of range', () => {
			const result = plugin.validateFormInput({ target_items: 0 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('target_items');
		});

		it('should reject max_pages_to_process out of range', () => {
			const result = plugin.validateFormInput({ max_pages_to_process: 1001 });
			expect(result.valid).toBe(false);
			expect(result.errors![0].path).toBe('max_pages_to_process');
		});

		it('should reject non-numeric values', () => {
			const result = plugin.validateFormInput({ target_items: 'abc' });
			expect(result.valid).toBe(false);
			expect(result.errors![0].message).toContain('must be a number');
		});

		it('should accept boundary values', () => {
			expect(plugin.validateFormInput({ target_items: 1, max_pages_to_process: 1 }).valid).toBe(true);
			expect(plugin.validateFormInput({ target_items: 500, max_pages_to_process: 1000 }).valid).toBe(true);
		});
	});

	describe('getDefaultValues', () => {
		it('should return defaults for capture_screenshots', () => {
			const defaults = plugin.getDefaultValues!();
			expect(defaults.capture_screenshots).toBe(false);
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

	describe('dedup helpers', () => {
		it('deduplicates generated items by normalized source_url', () => {
			const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			const items = [
				{
					name: 'Tool A',
					description: 'A',
					source_url: 'https://example.com/tool/',
					category: 'Cat'
				},
				{
					name: 'Tool A Mirror',
					description: 'A',
					source_url: 'https://example.com/tool',
					category: 'Cat'
				}
			] as unknown as MutableItemData[];

			const deduped = (plugin as any).deduplicateGeneratedItems(items, logger);
			expect(deduped).toHaveLength(1);
			expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Deduplicated generated items'));
		});

		it('deduplicates by normalized name when URL is missing', () => {
			const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			const items = [
				{ name: '  Tool B  ', description: 'B', source_url: '', category: 'Cat' },
				{ name: 'tool b', description: 'B', category: 'Cat' }
			] as unknown as MutableItemData[];

			const deduped = (plugin as any).deduplicateGeneratedItems(items, logger);
			expect(deduped).toHaveLength(1);
		});

		it('collects processUrls failures from tool results', () => {
			const steps = [
				{
					toolResults: [
						{
							toolName: 'processUrls',
							output: [
								{ url: 'https://a.com', files: ['a.json'], count: 1 },
								{ url: 'https://b.com', files: [], count: 0, error: 'timeout' }
							]
						}
					]
				}
			];

			const summary = (plugin as any).collectProcessUrlFailures(steps);
			expect(summary.totalUrls).toBe(2);
			expect(summary.failedUrls).toBe(1);
			expect(summary.sampleErrors).toContain('timeout');
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

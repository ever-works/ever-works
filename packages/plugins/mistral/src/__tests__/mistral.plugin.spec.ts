import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MistralPlugin } from '../mistral.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';
import { validateSettingsConstraints } from '@ever-works/plugin/api';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(function () {
		return {
			createChatCompletion: vi
				.fn()
				.mockResolvedValue({ id: 'test', choices: [], model: 'mistral-small-latest', created: 0 }),
			createStreamingChatCompletion: vi.fn(),
			createEmbedding: vi.fn(),
			askJson: vi.fn().mockResolvedValue({ result: {}, model: 'mistral-small-latest', usage: undefined }),
			listModels: vi.fn().mockResolvedValue([]),
			testConnection: vi.fn().mockResolvedValue({ success: true })
		};
	});
	return { AiOperations: MockAiOperations };
});

describe('MistralPlugin', () => {
	let plugin: MistralPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new MistralPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('mistral');
			expect(plugin.name).toBe('Mistral');
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have ai-provider category and capability', () => {
			expect(plugin.category).toBe('ai-provider');
			expect(plugin.capabilities).toContain('ai-provider');
		});

		it('should have user-required configuration mode', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});
	});

	describe('settingsSchema', () => {
		it('should have required apiKey and defaultModel fields', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.properties).toHaveProperty('apiKey');
			expect(plugin.settingsSchema.required).toContain('apiKey');
			expect(plugin.settingsSchema.required).toContain('defaultModel');
		});

		it('should have apiKey as secret and user-scoped', () => {
			const apiKeySchema = plugin.settingsSchema.properties?.apiKey as any;
			expect(apiKeySchema).toBeDefined();
			expect(apiKeySchema['x-secret']).toBe(true);
			expect(apiKeySchema['x-scope']).toBe('user');
			expect(apiKeySchema['x-envVar']).toBe('PLUGIN_MISTRAL_API_KEY');
		});

		it('should have defaultModel field', () => {
			const schema = plugin.settingsSchema.properties?.defaultModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Default Model');
			expect(schema['x-widget']).toBe('model-select');
			expect(schema['x-scope']).toBe('global');
		});

		it('should have simpleModel field', () => {
			const schema = plugin.settingsSchema.properties?.simpleModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Simple Tasks Model');
			expect(schema.description).toBe('Handles tags, short descriptions, and quick classifications');
		});

		it('should have mediumModel field', () => {
			const schema = plugin.settingsSchema.properties?.mediumModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Standard Tasks Model');
			expect(schema.description).toBe('Handles listings, summaries, and content reformatting');
		});

		it('should have complexModel field', () => {
			const schema = plugin.settingsSchema.properties?.complexModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Complex Tasks Model');
			expect(schema.description).toBe('Handles full page generation and multi-step analysis');
		});

		it('should have baseUrl field with default', () => {
			const schema = plugin.settingsSchema.properties?.baseUrl as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.default).toBe('https://api.mistral.ai/v1');
			expect(schema['x-envVar']).toBe('PLUGIN_MISTRAL_BASE_URL');
		});

		it('should have temperature field with constraints', () => {
			const schema = plugin.settingsSchema.properties?.temperature as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('number');
			expect(schema.default).toBe(0.7);
			expect(schema.minimum).toBe(0);
			expect(schema.maximum).toBe(2);
		});

		it('should have maxTokens field', () => {
			const schema = plugin.settingsSchema.properties?.maxTokens as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('number');
			expect(schema.default).toBe(4096);
		});

		it('should have all expected properties', () => {
			const properties = plugin.settingsSchema.properties;
			expect(properties).toHaveProperty('apiKey');
			expect(properties).toHaveProperty('defaultModel');
			expect(properties).toHaveProperty('simpleModel');
			expect(properties).toHaveProperty('mediumModel');
			expect(properties).toHaveProperty('complexModel');
			expect(properties).toHaveProperty('baseUrl');
			expect(properties).toHaveProperty('temperature');
			expect(properties).toHaveProperty('maxTokens');
		});

		it('should have description on all settings fields', () => {
			const props = plugin.settingsSchema.properties!;
			for (const [key, prop] of Object.entries(props)) {
				expect((prop as any).description, `${key} should have a description`).toBeDefined();
				expect((prop as any).description, `${key} description should not be empty`).not.toBe('');
			}
		});

		it('should have title on all settings fields', () => {
			const props = plugin.settingsSchema.properties!;
			for (const [key, prop] of Object.entries(props)) {
				expect((prop as any).title, `${key} should have a title`).toBeDefined();
			}
		});
	});

	/**
	 * Model defaults as of 2026-11-05 (models refresh), read on
	 * https://docs.mistral.ai/models that day. The tiers stay on Mistral's
	 * `-latest` aliases, which the vendor moves forward on its own:
	 *   mistral-small-latest  → mistral-small-2603 (Small 4, GA)
	 *   mistral-medium-latest → mistral-medium-3-5 (deprecated 2026-10-31, retires 2027-04-30)
	 *   mistral-large-latest  → mistral-large-2512 (Large 3; deprecated 2026-10-31, retires 2027-04-30)
	 * The suggested successor, mistral-large-4, is in Public Preview, so no
	 * default changes in this refresh; revisit when it is GA. These pins make a
	 * change to the aliases a deliberate one. Update from that page, never from
	 * memory.
	 */
	describe('model defaults (as of 2026-11-05)', () => {
		const EXPECTED_TIER_DEFAULTS: Record<string, string> = {
			defaultModel: 'mistral-small-latest',
			simpleModel: 'mistral-small-latest',
			mediumModel: 'mistral-medium-latest',
			complexModel: 'mistral-large-latest'
		};
		const EXPECTED_BOOTSTRAP_MODEL = 'mistral-small-latest';

		/** Pinned snapshots a user may have saved instead of the aliases. */
		const SAVED_SNAPSHOT_MODELS: Record<string, string> = {
			defaultModel: 'mistral-small-2603',
			simpleModel: 'mistral-small-2603',
			mediumModel: 'mistral-medium-latest',
			complexModel: 'mistral-large-2512'
		};

		const context = (): PluginContext =>
			({
				pluginId: 'mistral',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		const schemaDefault = (key: string): string =>
			(plugin.settingsSchema.properties![key] as { default: string }).default;

		const loadedAiOps = async () => {
			await plugin.onLoad(context());
			const MockAiOperations = AiOperations as unknown as ReturnType<typeof vi.fn>;
			return {
				bootstrapModel: (MockAiOperations.mock.calls[0][0] as { model: string }).model,
				aiOpsInstance: MockAiOperations.mock.results[0].value
			};
		};

		it("keeps each tier on the vendor's -latest alias for that role", () => {
			for (const [key, id] of Object.entries(EXPECTED_TIER_DEFAULTS)) {
				expect(schemaDefault(key), key).toBe(id);
			}
		});

		it('uses the default model for the onLoad bootstrap and getDefaultModelId()', async () => {
			const { bootstrapModel, aiOpsInstance } = await loadedAiOps();

			// No `defaultModel` in the settings: validateConnection falls back to
			// getDefaultModelId(), the path every unsaved config takes.
			await plugin.validateConnection({ apiKey: 'mistral-test' });
			const fallbackModel = aiOpsInstance.testConnection.mock.calls[0][1];

			expect(bootstrapModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(fallbackModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(schemaDefault('defaultModel')).toBe(EXPECTED_BOOTSTRAP_MODEL);
		});

		it('lets a saved snapshot id pass settings validation (no enum or pattern on the model fields)', () => {
			const props = plugin.settingsSchema.properties!;
			for (const key of Object.keys(SAVED_SNAPSHOT_MODELS)) {
				const prop = props[key] as Record<string, unknown>;
				expect(prop.type, key).toBe('string');
				expect(prop, key).not.toHaveProperty('enum');
				expect(prop, key).not.toHaveProperty('const');
				expect(prop, key).not.toHaveProperty('pattern');
			}
			expect(
				validateSettingsConstraints({ apiKey: 'mistral-test', ...SAVED_SNAPSHOT_MODELS }, props as never)
			).toEqual([]);
		});

		it('sends a saved snapshot id to AiOperations unchanged', async () => {
			const { aiOpsInstance } = await loadedAiOps();
			const settings = { apiKey: 'mistral-test', ...SAVED_SNAPSHOT_MODELS };

			await plugin.createChatCompletion({
				model: 'mistral-large-2512',
				messages: [{ role: 'user', content: 'hi' }],
				settings
			});
			const [options, config] = aiOpsInstance.createChatCompletion.mock.calls[0];
			expect(options.model).toBe('mistral-large-2512');
			expect(config.model).toBe('mistral-small-2603');

			await plugin.validateConnection(settings);
			const tested = aiOpsInstance.testConnection.mock.calls.map((call: unknown[]) => call[1]);
			expect([...tested].sort()).toEqual(['mistral-large-2512', 'mistral-medium-latest', 'mistral-small-2603']);
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'mistral',
				logger: {
					log: vi.fn(),
					debug: vi.fn(),
					warn: vi.fn(),
					error: vi.fn()
				},
				getSettings: vi.fn().mockResolvedValue({}),
				getResolvedSettings: vi.fn().mockResolvedValue({}),
				cache: {
					get: vi.fn(),
					set: vi.fn(),
					delete: vi.fn(),
					has: vi.fn(),
					clear: vi.fn()
				},
				http: {
					get: vi.fn(),
					post: vi.fn(),
					put: vi.fn(),
					patch: vi.fn(),
					delete: vi.fn()
				},
				env: {},
				envVars: {},
				services: {},
				onEvent: vi.fn(),
				emitEvent: vi.fn(),
				registerCustomCapability: vi.fn(),
				getCustomCapability: vi.fn(),
				hasCustomCapability: vi.fn(),
				listCustomCapabilities: vi.fn()
			}) as unknown as PluginContext;

		it('should load successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Mistral Plugin loaded');
		});

		it('should unload successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad(mockContext);
			await plugin.onUnload();
			// After unload, context should be cleared
		});
	});

	describe('manifest', () => {
		it('should return correct manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('mistral');
			expect(manifest.name).toBe('Mistral');
			expect(manifest.version).toBe('1.0.0');
			expect(manifest.category).toBe('ai-provider');
			expect(manifest.capabilities).toContain('ai-provider');
		});

		it('should have builtIn flag and autoEnable false', () => {
			const manifest = plugin.getManifest();
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(false);
		});

		it('should not have systemPlugin or defaultForCapabilities', () => {
			const manifest = plugin.getManifest();
			expect(manifest.systemPlugin).toBeUndefined();
			expect(manifest.defaultForCapabilities).toBeUndefined();
		});

		it('should have public visibility', () => {
			const manifest = plugin.getManifest();
			expect(manifest.visibility).toBe('public');
		});

		it('should have svg icon', () => {
			const manifest = plugin.getManifest();
			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('svg');
			expect(manifest.icon?.value).toContain('viewBox');
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('Mistral plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('getCapabilities', () => {
		it('should return correct AI capabilities', () => {
			const capabilities = plugin.getCapabilities();
			expect(capabilities.supportsStructuredOutput).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsToolCalling).toBe(true);
			expect(capabilities.supportsVision).toBe(true);
			expect(capabilities.maxContextLength).toBe(128000);
		});
	});

	describe('askJson', () => {
		const createMockContext2 = (): PluginContext =>
			({
				pluginId: 'mistral',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext2());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'mistral-test-key' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'mistral-test-key' }),
				expect.any(Object)
			);
		});

		it('should throw when plugin not loaded', async () => {
			await expect(plugin.askJson('test')).rejects.toThrow('Plugin not loaded');
		});
	});

	describe('settings threading', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'mistral',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should pass settings as configOverrides to AiOperations.listModels', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.listModels({ apiKey: 'mistral-test-key' });

			expect(aiOpsInstance.listModels).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'mistral-test-key' })
			);
		});

		it('should pass settings as configOverrides to AiOperations.testConnection', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.isAvailable({ apiKey: 'mistral-test-key' });

			expect(aiOpsInstance.testConnection).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'mistral-test-key' })
			);
		});
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAiPlugin } from '../openai.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';
import { validateSettingsConstraints } from '@ever-works/plugin/api';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(function () {
		return {
			createChatCompletion: vi.fn().mockResolvedValue({ id: 'test', choices: [], model: 'gpt-4', created: 0 }),
			createStreamingChatCompletion: vi.fn(),
			createEmbedding: vi.fn(),
			askJson: vi.fn().mockResolvedValue({ result: {}, model: 'gpt-4', usage: undefined }),
			listModels: vi.fn().mockResolvedValue([]),
			testConnection: vi.fn().mockResolvedValue({ success: true })
		};
	});
	return { AiOperations: MockAiOperations };
});

describe('OpenAiPlugin', () => {
	let plugin: OpenAiPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new OpenAiPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('openai');
			expect(plugin.name).toBe('OpenAI');
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
			expect(apiKeySchema.type).toBe('string');
			expect(apiKeySchema['x-secret']).toBe(true);
			expect(apiKeySchema['x-scope']).toBe('user');
		});

		it('should have all model settings', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('defaultModel');
			expect(props).toHaveProperty('simpleModel');
			expect(props).toHaveProperty('mediumModel');
			expect(props).toHaveProperty('complexModel');
		});

		it('should expose embeddingModel with text-embedding-3-small default for Phase 2 KB retrieval', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('embeddingModel');
			const schema = props.embeddingModel as Record<string, unknown>;
			expect(schema.type).toBe('string');
			expect(schema.default).toBe('text-embedding-3-small');
			// Global scope (not user) so a fresh sign-up inherits the
			// operator-pinned model without configuring it themselves —
			// matches the other model selectors.
			expect(schema['x-scope']).toBe('global');
		});

		it('should have temperature and maxTokens settings', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('temperature');
			expect(props).toHaveProperty('maxTokens');
			expect((props.temperature as any).type).toBe('number');
			expect((props.maxTokens as any).type).toBe('number');
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
	 * Model defaults as of 2026-11-05 (models refresh). Every id was read on the
	 * vendor's pages that day:
	 *   https://developers.openai.com/api/docs/models
	 *   https://developers.openai.com/api/docs/deprecations
	 * Each tier gets the vendor's current model for its role: simple = GPT-6 Luna
	 * (cost-sensitive), medium = GPT-6.1 Sol (balance), complex = GPT-6 Astra
	 * (flagship). The default keeps its shape (it equals the complex tier), and the
	 * onLoad bootstrap and getDefaultModelId() keep theirs (the simple tier's id).
	 * The previous ids are deprecated: gpt-5-nano shuts down 2026-12-11,
	 * gpt-4o-mini 2027-01-14 and gpt-5.1 2027-04-01. Update from those pages, never
	 * from memory.
	 */
	describe('model defaults (as of 2026-11-05)', () => {
		const EXPECTED_TIER_DEFAULTS: Record<string, string> = {
			defaultModel: 'gpt-6-astra',
			simpleModel: 'gpt-6-luna',
			mediumModel: 'gpt-6.1-sol',
			complexModel: 'gpt-6-astra'
		};
		const EXPECTED_BOOTSTRAP_MODEL = 'gpt-6-luna';

		/** The ids an earlier release shipped as defaults (still served, deprecated). */
		const LEGACY_SAVED_MODELS: Record<string, string> = {
			defaultModel: 'gpt-5.1',
			simpleModel: 'gpt-5-nano',
			mediumModel: 'gpt-4o-mini',
			complexModel: 'gpt-5.1'
		};

		const context = (): PluginContext =>
			({
				pluginId: 'openai',
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

		it("defaults each tier to the vendor's current model for that role", () => {
			for (const [key, id] of Object.entries(EXPECTED_TIER_DEFAULTS)) {
				expect(schemaDefault(key), key).toBe(id);
			}
		});

		it('uses the same id for the onLoad bootstrap, getDefaultModelId() and the simple tier', async () => {
			const { bootstrapModel, aiOpsInstance } = await loadedAiOps();

			// No `defaultModel` in the settings: validateConnection falls back to
			// getDefaultModelId(), the path every unsaved config takes.
			await plugin.validateConnection({ apiKey: 'sk-test' });
			const fallbackModel = aiOpsInstance.testConnection.mock.calls[0][1];

			expect(bootstrapModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(fallbackModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(schemaDefault('simpleModel')).toBe(EXPECTED_BOOTSTRAP_MODEL);
		});

		it('lets a saved legacy id pass settings validation (no enum or pattern on the model fields)', () => {
			const props = plugin.settingsSchema.properties!;
			for (const key of Object.keys(LEGACY_SAVED_MODELS)) {
				const prop = props[key] as Record<string, unknown>;
				expect(prop.type, key).toBe('string');
				expect(prop, key).not.toHaveProperty('enum');
				expect(prop, key).not.toHaveProperty('const');
				expect(prop, key).not.toHaveProperty('pattern');
			}
			expect(validateSettingsConstraints({ apiKey: 'sk-test', ...LEGACY_SAVED_MODELS }, props as never)).toEqual(
				[]
			);
		});

		it('sends a saved legacy id to AiOperations unchanged', async () => {
			const { aiOpsInstance } = await loadedAiOps();
			const settings = { apiKey: 'sk-test', ...LEGACY_SAVED_MODELS };

			await plugin.createChatCompletion({
				model: 'gpt-4o-mini',
				messages: [{ role: 'user', content: 'hi' }],
				settings
			});
			const [options, config] = aiOpsInstance.createChatCompletion.mock.calls[0];
			expect(options.model).toBe('gpt-4o-mini');
			expect(config.model).toBe('gpt-5.1');

			await plugin.validateConnection(settings);
			const tested = aiOpsInstance.testConnection.mock.calls.map((call: unknown[]) => call[1]);
			expect([...tested].sort()).toEqual(['gpt-4o-mini', 'gpt-5-nano', 'gpt-5.1']);
		});
	});

	describe('capabilities and manifest text', () => {
		it('advertises the GPT-6 family context window (1,050,000 tokens, developers.openai.com, 2026-11-05)', () => {
			expect(plugin.getCapabilities().maxContextLength).toBe(1050000);
		});

		it('names current models, not GPT-4o, in its marketing text', () => {
			const manifest = plugin.getManifest();
			expect(manifest.description).not.toMatch(/GPT-4o/);
			expect(manifest.readme).not.toMatch(/GPT-4o/);
			expect(manifest.readme).toMatch(/GPT-6 Astra/);
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'openai',
				logger: {
					log: vi.fn(),
					debug: vi.fn(),
					warn: vi.fn(),
					error: vi.fn()
				},
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should load successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('OpenAI Plugin loaded');
		});

		it('should unload successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad(mockContext);
			await plugin.onUnload();
		});
	});

	describe('manifest', () => {
		it('should return correct manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('openai');
			expect(manifest.name).toBe('OpenAI');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(false);
			expect(manifest.visibility).toBe('public');
			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('svg');
			expect(manifest.icon?.backgroundColor).toBe('#000000');
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('OpenAI plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('askJson', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'openai',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'sk-test' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'sk-test' }),
				expect.any(Object)
			);
		});

		it('should throw when plugin not loaded', async () => {
			await expect(plugin.askJson('test')).rejects.toThrow('Plugin not loaded');
		});
	});

	describe('createEmbedding', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'openai',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should throw when plugin not loaded', async () => {
			await expect(plugin.createEmbedding({ input: 'hello' })).rejects.toThrow('OpenAI plugin not loaded');
		});

		it('should delegate to aiOps.createEmbedding with options + resolved config', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
			aiOpsInstance.createEmbedding.mockResolvedValue({
				model: 'text-embedding-3-small',
				embeddings: [[0.1, 0.2]]
			});

			await plugin.createEmbedding({ input: 'hello' });

			expect(aiOpsInstance.createEmbedding).toHaveBeenCalledWith(
				expect.objectContaining({ input: 'hello' }),
				expect.objectContaining({ embeddingModel: 'text-embedding-3-small' })
			);
		});

		it('should preserve options.input array shape and forward dimensions', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
			aiOpsInstance.createEmbedding.mockResolvedValue({
				model: 'text-embedding-3-small',
				embeddings: [
					[0.1, 0.2],
					[0.3, 0.4]
				]
			});

			await plugin.createEmbedding({
				input: ['first', 'second'],
				dimensions: 512
			});

			const [firstArg] = aiOpsInstance.createEmbedding.mock.calls[0] as [{ input: unknown; dimensions: unknown }];
			expect(firstArg.input).toEqual(['first', 'second']);
			expect(firstArg.dimensions).toBe(512);
		});

		it('should honor a user-provided embeddingModel setting over the text-embedding-3-small default', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
			aiOpsInstance.createEmbedding.mockResolvedValue({
				model: 'text-embedding-3-large',
				embeddings: [[0.1]]
			});

			await plugin.createEmbedding({
				input: 'hello',
				settings: { embeddingModel: 'text-embedding-3-large' }
			});

			expect(aiOpsInstance.createEmbedding).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({ embeddingModel: 'text-embedding-3-large' })
			);
		});

		it('should NOT inject the default when options.model is explicitly set', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
			aiOpsInstance.createEmbedding.mockResolvedValue({
				model: 'text-embedding-ada-002',
				embeddings: [[0.1]]
			});

			await plugin.createEmbedding({
				input: 'hello',
				model: 'text-embedding-ada-002'
			});

			// options.model takes precedence inside AiOperations.createEmbedding —
			// the resolved config should NOT carry a fallback embeddingModel, so
			// the caller's explicit choice wins.
			const [, configArg] = aiOpsInstance.createEmbedding.mock.calls[0] as [unknown, { embeddingModel?: string }];
			expect(configArg.embeddingModel).toBeUndefined();
		});
	});

	describe('settings threading', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'openai',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should pass settings as configOverrides to AiOperations.listModels', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.listModels({ apiKey: 'sk-test' });

			expect(aiOpsInstance.listModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }));
		});

		it('should pass settings as configOverrides to AiOperations.testConnection', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.isAvailable({ apiKey: 'sk-test' });

			expect(aiOpsInstance.testConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }));
		});
	});
});

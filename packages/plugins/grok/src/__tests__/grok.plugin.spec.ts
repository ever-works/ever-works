import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrokPlugin } from '../grok.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';
import { validateSettingsConstraints } from '@ever-works/plugin/api';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(function () {
		return {
			createChatCompletion: vi.fn().mockResolvedValue({ id: 'test', choices: [], model: 'grok', created: 0 }),
			createStreamingChatCompletion: vi.fn(),
			createEmbedding: vi.fn(),
			askJson: vi.fn().mockResolvedValue({ result: {}, model: 'grok', usage: undefined }),
			listModels: vi.fn().mockResolvedValue([]),
			testConnection: vi.fn().mockResolvedValue({ success: true })
		};
	});
	return { AiOperations: MockAiOperations };
});

describe('GrokPlugin', () => {
	let plugin: GrokPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new GrokPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('grok');
			expect(plugin.name).toBe('Grok (xAI)');
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have ai-provider category and capability', () => {
			expect(plugin.category).toBe('ai-provider');
			expect(plugin.capabilities).toContain('ai-provider');
		});

		it('should have user-required configuration mode', () => {
			expect(plugin.configurationMode).toBe('user-required');
		});

		it('should expose xAI as the provider', () => {
			expect(plugin.providerType).toBe('grok');
			expect(plugin.providerName).toBe('xAI');
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

		it('should have apiKey as secret and user-scoped with env-var fallback', () => {
			const apiKeySchema = plugin.settingsSchema.properties?.apiKey as Record<string, unknown>;
			expect(apiKeySchema).toBeDefined();
			expect(apiKeySchema.type).toBe('string');
			expect(apiKeySchema['x-secret']).toBe(true);
			expect(apiKeySchema['x-scope']).toBe('user');
			expect(apiKeySchema['x-envVar']).toBe('XAI_API_KEY');
		});

		/**
		 * Every tier used to default to `grok-2-latest`, an id the xAI API no
		 * longer lists. The list below is the set of text model ids on the
		 * vendor's models page on 2026-10-28:
		 *   https://docs.x.ai/developers/models
		 * minus `grok-4.20-multi-agent-0309`, which is not a Chat Completions
		 * model (the API this plugin speaks), so it must never be a default.
		 * Update it from that page, never from memory.
		 */
		const VERIFIED_XAI_TEXT_MODEL_IDS = [
			'grok-4.7',
			'grok-4.6',
			'grok-4.5',
			'grok-4.3',
			'grok-4.20-0309-reasoning',
			'grok-4.20-0309-non-reasoning',
			'grok-build-0.1'
		];

		it('should default every model tier to an id the xAI API lists', () => {
			const props = plugin.settingsSchema.properties!;
			for (const key of ['defaultModel', 'simpleModel', 'mediumModel', 'complexModel']) {
				expect(VERIFIED_XAI_TEXT_MODEL_IDS, key).toContain((props[key] as { default: string }).default);
			}
		});

		it('should use the same default in the settings schema, the onLoad bootstrap and getDefaultModelId()', async () => {
			await plugin.onLoad({
				pluginId: 'grok',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			} as unknown as PluginContext);
			const MockAiOperations = AiOperations as unknown as ReturnType<typeof vi.fn>;
			const bootstrapModel = (MockAiOperations.mock.calls[0][0] as { model: string }).model;
			const aiOpsInstance = MockAiOperations.mock.results[0].value;

			// No `defaultModel` in the settings: validateConnection falls back to
			// getDefaultModelId(), the path every unsaved config takes.
			await plugin.validateConnection({ apiKey: 'xai-test' });
			const validatedModel = aiOpsInstance.testConnection.mock.calls[0][1];

			const schemaDefault = (plugin.settingsSchema.properties!.defaultModel as { default: string }).default;
			expect(bootstrapModel).toBe(schemaDefault);
			expect(validatedModel).toBe(schemaDefault);
			expect(VERIFIED_XAI_TEXT_MODEL_IDS).toContain(validatedModel);
		});

		it('should point baseUrl at the xAI API by default', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('baseUrl');
			expect((props.baseUrl as { type: string }).type).toBe('string');
			expect((props.baseUrl as { default: string }).default).toBe('https://api.x.ai/v1');
		});

		it('should have temperature and maxTokens settings', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('temperature');
			expect(props).toHaveProperty('maxTokens');
			expect((props.temperature as { type: string }).type).toBe('number');
			expect((props.maxTokens as { type: string }).type).toBe('number');
		});

		it('should have description and title on all settings fields', () => {
			const props = plugin.settingsSchema.properties!;
			for (const [key, prop] of Object.entries(props)) {
				const typed = prop as { title?: string; description?: string };
				expect(typed.description, `${key} should have a description`).toBeDefined();
				expect(typed.description, `${key} description should not be empty`).not.toBe('');
				expect(typed.title, `${key} should have a title`).toBeDefined();
			}
		});
	});

	/**
	 * Model defaults as of 2026-11-05 (models refresh), read on
	 * https://docs.x.ai/developers/models that day. Each tier gets the vendor's
	 * current model for its role: simple = Grok 4.3 ("Fast, reliable", $1.25 /
	 * $2.50 per MTok, 1M context), medium and complex = Grok 4.7 (the model the
	 * page recommends "for everything else, including code"). The default keeps
	 * its shape (it equals the complex tier).
	 *
	 * Intentional spec change: the simple tier used to share Grok 4.7 with the
	 * other tiers; each tier is now pinned to its exact id. The list-membership
	 * test above is unchanged and still holds. Update from that page, never from
	 * memory.
	 */
	describe('model defaults (as of 2026-11-05)', () => {
		const EXPECTED_TIER_DEFAULTS: Record<string, string> = {
			defaultModel: 'grok-4.7',
			simpleModel: 'grok-4.3',
			mediumModel: 'grok-4.7',
			complexModel: 'grok-4.7'
		};
		const EXPECTED_BOOTSTRAP_MODEL = 'grok-4.7';

		/** The id every tier shipped with until 2026-10-28 (no longer documented by xAI). */
		const LEGACY_SAVED_MODELS: Record<string, string> = {
			defaultModel: 'grok-2-latest',
			simpleModel: 'grok-2-latest',
			mediumModel: 'grok-2-latest',
			complexModel: 'grok-2-latest'
		};

		const context = (): PluginContext =>
			({
				pluginId: 'grok',
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

		it('uses the default model for the onLoad bootstrap and getDefaultModelId()', async () => {
			const { bootstrapModel, aiOpsInstance } = await loadedAiOps();

			await plugin.validateConnection({ apiKey: 'xai-test' });
			const fallbackModel = aiOpsInstance.testConnection.mock.calls[0][1];

			expect(bootstrapModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(fallbackModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(schemaDefault('defaultModel')).toBe(EXPECTED_BOOTSTRAP_MODEL);
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
			expect(validateSettingsConstraints({ apiKey: 'xai-test', ...LEGACY_SAVED_MODELS }, props as never)).toEqual(
				[]
			);
		});

		it('sends a saved legacy id to AiOperations unchanged', async () => {
			const { aiOpsInstance } = await loadedAiOps();
			const settings = { apiKey: 'xai-test', ...LEGACY_SAVED_MODELS };

			await plugin.createChatCompletion({
				model: 'grok-2-latest',
				messages: [{ role: 'user', content: 'hi' }],
				settings
			});
			const [options, config] = aiOpsInstance.createChatCompletion.mock.calls[0];
			expect(options.model).toBe('grok-2-latest');
			expect(config.model).toBe('grok-2-latest');

			await plugin.validateConnection(settings);
			const tested = aiOpsInstance.testConnection.mock.calls.map((call: unknown[]) => call[1]);
			expect(tested).toEqual(['grok-2-latest']);
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'grok',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('Grok Plugin loaded');
		});

		it('should unload successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onLoad(mockContext);
			await plugin.onUnload();
		});
	});

	describe('manifest', () => {
		it('should return a correct, onboarding-eligible manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('grok');
			expect(manifest.name).toBe('Grok (xAI)');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(false);
			expect(manifest.visibility).toBe('public');
			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('svg');
			expect(manifest.uiHints?.includeInOnboarding).toBe(true);
			expect(manifest.uiHints?.onboardingPriority).toBe(3);
			expect(manifest.uiHints?.completionFields).toEqual(['apiKey', 'defaultModel']);
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('Grok plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('askJson', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'grok',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'xai-test' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'xai-test' }),
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
				pluginId: 'grok',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should pass settings as configOverrides to AiOperations.listModels', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.listModels({ apiKey: 'test-key' });

			expect(aiOpsInstance.listModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
		});

		it('should pass settings as configOverrides to AiOperations.testConnection', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.isAvailable({ apiKey: 'test-key' });

			expect(aiOpsInstance.testConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key' }));
		});
	});

	describe('capabilities', () => {
		it('should advertise the full xAI feature set', () => {
			const caps = plugin.getCapabilities();
			expect(caps.supportsStructuredOutput).toBe(true);
			expect(caps.supportsStreaming).toBe(true);
			expect(caps.supportsToolCalling).toBe(true);
			expect(caps.supportsVision).toBe(true);
			expect(caps.maxContextLength).toBe(131072);
		});
	});

	describe('embeddings', () => {
		it('should reject embedding calls', async () => {
			await expect(plugin.createEmbedding({ input: 'hi' } as never)).rejects.toThrow(
				'Embeddings not supported by Grok'
			);
		});
	});
});

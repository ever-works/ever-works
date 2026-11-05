import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroqPlugin } from '../groq.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';
import { validateSettingsConstraints } from '@ever-works/plugin/api';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(function () {
		return {
			createChatCompletion: vi.fn().mockResolvedValue({ id: 'test', choices: [], model: 'llama', created: 0 }),
			createStreamingChatCompletion: vi.fn(),
			createEmbedding: vi.fn(),
			askJson: vi.fn().mockResolvedValue({ result: {}, model: 'llama', usage: undefined }),
			listModels: vi.fn().mockResolvedValue([]),
			testConnection: vi.fn().mockResolvedValue({ success: true })
		};
	});
	return { AiOperations: MockAiOperations };
});

describe('GroqPlugin', () => {
	let plugin: GroqPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new GroqPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('groq');
			expect(plugin.name).toBe('Groq');
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

		it('should have baseUrl setting', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('baseUrl');
			expect((props.baseUrl as any).type).toBe('string');
			expect((props.baseUrl as any).default).toBe('https://api.groq.com/openai/v1');
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
	 *   https://console.groq.com/docs/models
	 *   https://console.groq.com/docs/deprecations
	 * Fix: every tier defaulted to `qwen/qwen3-32b`, which Groq retired on
	 * 2026-07-17 (successor gpt-oss-120b), so every unsaved config was broken.
	 * Each tier now gets a production model for its role: simple =
	 * openai/gpt-oss-20b, medium and complex = openai/gpt-oss-120b (featured).
	 * The default keeps its shape (it equals the medium and complex tiers).
	 * Update from those pages, never from memory.
	 */
	describe('model defaults (as of 2026-11-05)', () => {
		const EXPECTED_TIER_DEFAULTS: Record<string, string> = {
			defaultModel: 'openai/gpt-oss-120b',
			simpleModel: 'openai/gpt-oss-20b',
			mediumModel: 'openai/gpt-oss-120b',
			complexModel: 'openai/gpt-oss-120b'
		};
		const EXPECTED_BOOTSTRAP_MODEL = 'openai/gpt-oss-120b';

		/** The id every tier shipped with until this refresh (retired by Groq on 2026-07-17). */
		const LEGACY_SAVED_MODELS: Record<string, string> = {
			defaultModel: 'qwen/qwen3-32b',
			simpleModel: 'qwen/qwen3-32b',
			mediumModel: 'qwen/qwen3-32b',
			complexModel: 'qwen/qwen3-32b'
		};

		const context = (): PluginContext =>
			({
				pluginId: 'groq',
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

			// No `defaultModel` in the settings: validateConnection falls back to
			// getDefaultModelId(), the path every unsaved config takes.
			await plugin.validateConnection({ apiKey: 'gsk-test' });
			const fallbackModel = aiOpsInstance.testConnection.mock.calls[0][1];

			expect(bootstrapModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(fallbackModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(schemaDefault('defaultModel')).toBe(EXPECTED_BOOTSTRAP_MODEL);
		});

		it('never defaults any field to the retired qwen/qwen3-32b', () => {
			for (const [key, prop] of Object.entries(plugin.settingsSchema.properties!)) {
				expect((prop as { default?: unknown }).default, key).not.toBe('qwen/qwen3-32b');
			}
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
			expect(validateSettingsConstraints({ apiKey: 'gsk-test', ...LEGACY_SAVED_MODELS }, props as never)).toEqual(
				[]
			);
		});

		// A retired id is still sent as saved: the vendor's error then tells the
		// user to pick another model. The plugin never rewrites a saved selection.
		it('sends a saved legacy id to AiOperations unchanged', async () => {
			const { aiOpsInstance } = await loadedAiOps();
			const settings = { apiKey: 'gsk-test', ...LEGACY_SAVED_MODELS };

			await plugin.createChatCompletion({
				model: 'qwen/qwen3-32b',
				messages: [{ role: 'user', content: 'hi' }],
				settings
			});
			const [options, config] = aiOpsInstance.createChatCompletion.mock.calls[0];
			expect(options.model).toBe('qwen/qwen3-32b');
			expect(config.model).toBe('qwen/qwen3-32b');

			await plugin.validateConnection(settings);
			const tested = aiOpsInstance.testConnection.mock.calls.map((call: unknown[]) => call[1]);
			expect(tested).toEqual(['qwen/qwen3-32b']);
		});
	});

	describe('manifest text', () => {
		it('names the models Groq serves today, not Mixtral', () => {
			const readme = plugin.getManifest().readme;
			expect(readme).not.toMatch(/Mixtral/);
			expect(readme).toMatch(/gpt-oss/);
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'groq',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('Groq Plugin loaded');
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
			expect(manifest.id).toBe('groq');
			expect(manifest.name).toBe('Groq');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(false);
			expect(manifest.visibility).toBe('public');
			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('svg');
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('Groq plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('askJson', () => {
		const createMockContext2 = (): PluginContext =>
			({
				pluginId: 'groq',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext2());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'groq-test' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'groq-test' }),
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
				pluginId: 'groq',
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
});

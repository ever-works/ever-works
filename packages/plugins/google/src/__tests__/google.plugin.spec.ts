import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GooglePlugin } from '../google.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';
import { validateSettingsConstraints } from '@ever-works/plugin/api';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(function () {
		return {
			createChatCompletion: vi.fn().mockResolvedValue({ id: 'test', choices: [], model: 'gemini', created: 0 }),
			createStreamingChatCompletion: vi.fn(),
			createEmbedding: vi.fn(),
			askJson: vi.fn().mockResolvedValue({ result: {}, model: 'gemini', usage: undefined }),
			listModels: vi.fn().mockResolvedValue([]),
			testConnection: vi.fn().mockResolvedValue({ success: true })
		};
	});
	return { AiOperations: MockAiOperations };
});

describe('GooglePlugin', () => {
	let plugin: GooglePlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new GooglePlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('google');
			expect(plugin.name).toBe('Google Gemini');
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
			expect((props.baseUrl as any).default).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
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
	 * vendor's pages that day (ai.google.dev/gemini-api/docs/* redirects here):
	 *   https://aistudio.google.com/docs/models
	 *   https://aistudio.google.com/docs/deprecations
	 *   https://aistudio.google.com/docs/changelog
	 * Each tier gets the vendor's current model for its role: simple = Gemini 3.5
	 * Flash-Lite ("fastest, most cost-effective"), medium = Gemini 3.8 Flash,
	 * complex = Gemini 4 Argon (flagship, GA 2026-10-13). The default keeps its
	 * shape (it equals the medium tier) and the `models/` prefix stays. Fixes:
	 * the simple tier's previous id, gemini-2.0-flash, was shut down on
	 * 2026-06-01; gemini-2.5-flash and gemini-2.5-pro are deprecated since
	 * 2026-11-02. Update from those pages, never from memory.
	 */
	describe('model defaults (as of 2026-11-05)', () => {
		const EXPECTED_TIER_DEFAULTS: Record<string, string> = {
			defaultModel: 'models/gemini-3.8-flash',
			simpleModel: 'models/gemini-3.5-flash-lite',
			mediumModel: 'models/gemini-3.8-flash',
			complexModel: 'models/gemini-4-argon'
		};
		const EXPECTED_BOOTSTRAP_MODEL = 'models/gemini-3.8-flash';

		/** Ids an earlier release shipped as tier defaults (2.0 Flash is shut down, 2.5 is deprecated). */
		const LEGACY_SAVED_MODELS: Record<string, string> = {
			defaultModel: 'models/gemini-2.5-flash',
			simpleModel: 'models/gemini-2.0-flash',
			mediumModel: 'models/gemini-2.5-flash',
			complexModel: 'models/gemini-2.5-pro'
		};

		const context = (): PluginContext =>
			({
				pluginId: 'google',
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
			await plugin.validateConnection({ apiKey: 'google-test' });
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
			expect(
				validateSettingsConstraints({ apiKey: 'google-test', ...LEGACY_SAVED_MODELS }, props as never)
			).toEqual([]);
		});

		it('sends a saved legacy id to AiOperations unchanged', async () => {
			const { aiOpsInstance } = await loadedAiOps();
			const settings = { apiKey: 'google-test', ...LEGACY_SAVED_MODELS };

			await plugin.createChatCompletion({
				model: 'models/gemini-2.5-pro',
				messages: [{ role: 'user', content: 'hi' }],
				settings
			});
			const [options, config] = aiOpsInstance.createChatCompletion.mock.calls[0];
			expect(options.model).toBe('models/gemini-2.5-pro');
			expect(config.model).toBe('models/gemini-2.5-flash');

			await plugin.validateConnection(settings);
			const tested = aiOpsInstance.testConnection.mock.calls.map((call: unknown[]) => call[1]);
			expect([...tested].sort()).toEqual([
				'models/gemini-2.0-flash',
				'models/gemini-2.5-flash',
				'models/gemini-2.5-pro'
			]);
		});
	});

	describe('manifest text', () => {
		it('names the current complex-tier model, not "Gemini Pro"', () => {
			const readme = plugin.getManifest().readme;
			expect(readme).not.toMatch(/Gemini Pro/);
			expect(readme).toMatch(/Gemini 4 Argon/);
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'google',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('Google Gemini Plugin loaded');
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
			expect(manifest.id).toBe('google');
			expect(manifest.name).toBe('Google Gemini');
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
			expect(health.message).toBe('Google Gemini plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('askJson', () => {
		const createMockContext2 = (): PluginContext =>
			({
				pluginId: 'google',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext2());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'google-test' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'google-test' }),
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
				pluginId: 'google',
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

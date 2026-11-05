import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterPlugin } from '../openrouter.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';
import { validateSettingsConstraints } from '@ever-works/plugin/api';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(function () {
		return {
			createChatCompletion: vi
				.fn()
				.mockResolvedValue({ id: 'test', choices: [], model: 'openai/gpt-4', created: 0 }),
			createStreamingChatCompletion: vi.fn(),
			createEmbedding: vi.fn(),
			askJson: vi.fn().mockResolvedValue({ result: {}, model: 'openai/gpt-4', usage: undefined }),
			listModels: vi.fn().mockResolvedValue([]),
			testConnection: vi.fn().mockResolvedValue({ success: true })
		};
	});
	return { AiOperations: MockAiOperations };
});

describe('OpenRouterPlugin', () => {
	let plugin: OpenRouterPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new OpenRouterPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('openrouter');
			expect(plugin.name).toBe('OpenRouter');
			expect(plugin.version).toBe('1.0.0');
		});

		it('should have ai-provider category and capability', () => {
			expect(plugin.category).toBe('ai-provider');
			expect(plugin.capabilities).toContain('ai-provider');
		});

		it('should have hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
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
			expect(apiKeySchema['x-envVar']).toBe('PLUGIN_OPENROUTER_API_KEY');
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
			expect(schema.default).toBe('https://openrouter.ai/api/v1');
			expect(schema['x-envVar']).toBe('PLUGIN_OPENROUTER_BASE_URL');
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
	 * Model defaults as of 2026-11-05 (models refresh). Every id was on the
	 * gateway's live model list that day (https://openrouter.ai/api/v1/models) and is the
	 * vendor's current model for its role (https://developers.openai.com/api/docs/models:
	 * GPT-6 Astra is the flagship, GPT-6.1 Sol balances intelligence and cost,
	 * GPT-6 Luna is for cost-sensitive, high-volume work). The previous ids are
	 * deprecated by OpenAI (openai/gpt-5-mini and openai/gpt-5 shut down 2026-12-11). Each field keeps its shape (the default equals the medium tier).
	 * A config that saved a model keeps it; configs that never saved one move
	 * to these defaults (owner decision, 2026-11-05). Update from those pages,
	 * never from memory.
	 */
	describe('model defaults (as of 2026-11-05)', () => {
		const EXPECTED_TIER_DEFAULTS: Record<string, string> = {
			defaultModel: 'openai/gpt-6.1-sol',
			simpleModel: 'openai/gpt-6-luna',
			mediumModel: 'openai/gpt-6.1-sol',
			complexModel: 'openai/gpt-6-astra'
		};
		const EXPECTED_BOOTSTRAP_MODEL = 'openai/gpt-6-luna';

		/** The ids this plugin shipped with until this refresh. */
		const LEGACY_SAVED_MODELS: Record<string, string> = {
			defaultModel: 'openai/gpt-5-mini',
			simpleModel: 'openai/gpt-5-mini',
			mediumModel: 'openai/gpt-5-mini',
			complexModel: 'openai/gpt-5'
		};

		const context = (): PluginContext =>
			({
				pluginId: 'openrouter',
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

		it('uses the simple tier for the onLoad bootstrap and getDefaultModelId()', async () => {
			const { bootstrapModel, aiOpsInstance } = await loadedAiOps();

			// No `defaultModel` in the settings: validateConnection falls back to
			// getDefaultModelId(), the path every unsaved config takes.
			await plugin.validateConnection({ apiKey: 'test-key' });
			const fallbackModel = aiOpsInstance.testConnection.mock.calls[0][1];

			expect(bootstrapModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
			expect(fallbackModel).toBe(EXPECTED_BOOTSTRAP_MODEL);
		});

		it('keeps the env var name of every tier', () => {
			for (const key of Object.keys(EXPECTED_TIER_DEFAULTS)) {
				const prop = plugin.settingsSchema.properties![key] as Record<string, unknown>;
				expect(prop['x-envVar'], key).toBe(`PLUGIN_OPENROUTER_${key.replace('Model', '').toUpperCase()}_MODEL`);
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
			expect(validateSettingsConstraints({ apiKey: 'test-key', ...LEGACY_SAVED_MODELS }, props as never)).toEqual(
				[]
			);
		});

		it('sends a saved legacy id to AiOperations unchanged', async () => {
			const { aiOpsInstance } = await loadedAiOps();
			const settings = { apiKey: 'test-key', ...LEGACY_SAVED_MODELS };

			await plugin.createChatCompletion({
				model: LEGACY_SAVED_MODELS.complexModel,
				messages: [{ role: 'user', content: 'hi' }],
				settings
			});
			const [options, config] = aiOpsInstance.createChatCompletion.mock.calls[0];
			expect(options.model).toBe(LEGACY_SAVED_MODELS.complexModel);
			expect(config.model).toBe(LEGACY_SAVED_MODELS.defaultModel);
		});

		// Env/docs consistency (models refresh §8.8): the sample env files and the
		// env-var reference must show the code defaults, not stale values.
		it('matches the sample env files and docs/environment-variables.md', () => {
			const repoRoot = resolve(__dirname, '../../../../..');
			const read = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');
			for (const file of ['.env.compose', '.env.demo.compose', 'apps/api/.env.example']) {
				const text = read(file);
				for (const [key, id] of Object.entries(EXPECTED_TIER_DEFAULTS)) {
					const name = `PLUGIN_OPENROUTER_${key.replace('Model', '').toUpperCase()}_MODEL`;
					const match = text.match(new RegExp(`^${name}='([^']*)'`, 'm'));
					expect(match?.[1], `${file} ${name}`).toBe(id);
				}
			}
			const doc = read('docs/environment-variables.md');
			for (const [key, id] of Object.entries(EXPECTED_TIER_DEFAULTS)) {
				const name = `PLUGIN_OPENROUTER_${key.replace('Model', '').toUpperCase()}_MODEL`;
				const row = doc.split('\n').find((line) => line.includes(`\`${name}\``));
				expect(row, name).toContain(`\`${id}\``);
			}
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'openrouter',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('OpenRouter Plugin loaded');
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
			expect(manifest.id).toBe('openrouter');
			expect(manifest.name).toBe('OpenRouter');
			expect(manifest.version).toBe('1.0.0');
			expect(manifest.category).toBe('ai-provider');
			expect(manifest.capabilities).toContain('ai-provider');
		});

		it('should have builtIn, autoEnable and systemPlugin flags', () => {
			const manifest = plugin.getManifest();
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(true);
			expect(manifest.systemPlugin).toBe(true);
		});

		it('should have defaultForCapabilities including ai-provider', () => {
			const manifest = plugin.getManifest();
			expect(manifest.defaultForCapabilities).toContain('ai-provider');
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
			expect(manifest.icon?.backgroundColor).toBe('#94A3B8');
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('OpenRouter plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('getCapabilities', () => {
		it('should return correct AI capabilities', () => {
			const capabilities = plugin.getCapabilities();
			expect(capabilities.supportsStructuredOutput).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsToolCalling).toBe(true);
			expect(capabilities.supportsVision).toBe(false);
			expect(capabilities.maxContextLength).toBe(128000);
		});
	});

	describe('askJson', () => {
		const createMockContext2 = (): PluginContext =>
			({
				pluginId: 'openrouter',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext2());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'sk-or-test' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'sk-or-test' }),
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
				pluginId: 'openrouter',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should pass settings as configOverrides to AiOperations.listModels', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.listModels({ apiKey: 'sk-or-test' });

			expect(aiOpsInstance.listModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-or-test' }));
		});

		it('should pass settings as configOverrides to AiOperations.testConnection', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.isAvailable({ apiKey: 'sk-or-test' });

			expect(aiOpsInstance.testConnection).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'sk-or-test' })
			);
		});
	});
});

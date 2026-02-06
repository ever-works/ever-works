import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterPlugin } from '../openrouter.plugin';
import type { PluginContext } from '@ever-works/plugin';

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
		it('should have required apiKey field', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.properties).toHaveProperty('apiKey');
			expect(plugin.settingsSchema.required).toContain('apiKey');
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
			expect(schema.default).toBe('openai/gpt-5-nano');
			expect(schema['x-widget']).toBe('model-select');
			expect(schema['x-scope']).toBe('user');
		});

		it('should have simpleModel field', () => {
			const schema = plugin.settingsSchema.properties?.simpleModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Simple Tasks Model');
			expect(schema.description).toBe('Handles tags, short descriptions, and quick classifications');
			expect(schema.default).toBe('openai/gpt-5-nano');
		});

		it('should have mediumModel field', () => {
			const schema = plugin.settingsSchema.properties?.mediumModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Standard Tasks Model');
			expect(schema.description).toBe('Handles listings, summaries, and content reformatting');
			expect(schema.default).toBe('moonshotai/kimi-k2.5');
		});

		it('should have complexModel field', () => {
			const schema = plugin.settingsSchema.properties?.complexModel as any;
			expect(schema).toBeDefined();
			expect(schema.type).toBe('string');
			expect(schema.title).toBe('Complex Tasks Model');
			expect(schema.description).toBe('Handles full page generation and multi-step analysis');
			expect(schema.default).toBe('moonshotai/kimi-k2.5');
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

		it('should enable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onEnable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('OpenRouter Plugin enabled');
		});

		it('should disable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onDisable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('OpenRouter Plugin disabled');
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

	describe('validateSettings', () => {
		it('should return valid when apiKey is provided', async () => {
			const result = await plugin.validateSettings({ apiKey: 'sk-or-valid-key' });
			expect(result.valid).toBe(true);
			expect(result.errors).toBeUndefined();
		});

		it('should return invalid when apiKey is missing', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]?.path).toBe('apiKey');
		});

		it('should return invalid when apiKey is empty string', async () => {
			const result = await plugin.validateSettings({ apiKey: '' });
			expect(result.valid).toBe(false);
		});

		it('should accept valid settings with optional fields', async () => {
			const result = await plugin.validateSettings({
				apiKey: 'sk-or-valid-key',
				defaultModel: 'moonshotai/kimi-k2.5',
				temperature: 0.5,
				maxTokens: 8192
			});
			expect(result.valid).toBe(true);
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
});

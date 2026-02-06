import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicPlugin } from '../anthropic.plugin';
import type { PluginContext } from '@ever-works/plugin';

describe('AnthropicPlugin', () => {
	let plugin: AnthropicPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new AnthropicPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('anthropic');
			expect(plugin.name).toBe('Anthropic');
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
		it('should have required apiKey field', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.properties).toHaveProperty('apiKey');
			expect(plugin.settingsSchema.required).toContain('apiKey');
		});

		it('should have apiKey as secret and user-scoped', () => {
			const apiKeySchema = plugin.settingsSchema.properties?.apiKey as any;
			expect(apiKeySchema).toBeDefined();
			expect(apiKeySchema.type).toBe('string');
			expect(apiKeySchema['x-secret']).toBe(true);
			expect(apiKeySchema['x-masked']).toBe(true);
			expect(apiKeySchema['x-writeOnly']).toBe(true);
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
			expect((props.baseUrl as any).default).toBe('https://api.anthropic.com/v1/');
		});

		it('should have temperature and maxTokens settings', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('temperature');
			expect(props).toHaveProperty('maxTokens');
			expect((props.temperature as any).type).toBe('number');
			expect((props.maxTokens as any).type).toBe('number');
		});
	});

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'anthropic',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('Anthropic Plugin loaded');
		});

		it('should enable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onEnable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Anthropic Plugin enabled');
		});

		it('should disable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onDisable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Anthropic Plugin disabled');
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
			expect(manifest.id).toBe('anthropic');
			expect(manifest.name).toBe('Anthropic');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(false);
			expect(manifest.visibility).toBe('public');
			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('svg');
			expect(manifest.icon?.backgroundColor).toBe('#191919');
		});
	});

	describe('validateSettings', () => {
		it('should return valid when apiKey is provided', async () => {
			const result = await plugin.validateSettings({ apiKey: 'sk-ant-test-key' });
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
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('Anthropic plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaPlugin } from '../ollama.plugin';
import type { PluginContext } from '@ever-works/plugin';

describe('OllamaPlugin', () => {
	let plugin: OllamaPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new OllamaPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('ollama');
			expect(plugin.name).toBe('Ollama');
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
		it('should have no required fields', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.required).toEqual([]);
		});

		it('should have apiKey with default value', () => {
			const apiKeySchema = plugin.settingsSchema.properties?.apiKey as any;
			expect(apiKeySchema).toBeDefined();
			expect(apiKeySchema.type).toBe('string');
			expect(apiKeySchema.default).toBe('ollama');
			expect(apiKeySchema['x-scope']).toBe('user');
		});

		it('should have all model settings', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('defaultModel');
			expect(props).toHaveProperty('simpleModel');
			expect(props).toHaveProperty('mediumModel');
			expect(props).toHaveProperty('complexModel');
			expect(props).toHaveProperty('embeddingModel');
		});

		it('should have baseUrl setting with localhost default', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('baseUrl');
			expect((props.baseUrl as any).type).toBe('string');
			expect((props.baseUrl as any).title).toBe('Ollama Server URL');
			expect((props.baseUrl as any).default).toBe('http://localhost:11434/v1');
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
				pluginId: 'ollama',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('Ollama Plugin loaded');
		});

		it('should enable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onEnable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Ollama Plugin enabled');
		});

		it('should disable successfully', async () => {
			const mockContext = createMockContext();
			await plugin.onDisable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Ollama Plugin disabled');
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
			expect(manifest.id).toBe('ollama');
			expect(manifest.name).toBe('Ollama');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.autoEnable).toBe(false);
			expect(manifest.visibility).toBe('public');
			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('svg');
			expect(manifest.icon?.backgroundColor).toBe('#000000');
		});
	});

	describe('validateSettings', () => {
		it('should return valid with no settings', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(true);
		});

		it('should return valid with custom settings', async () => {
			const result = await plugin.validateSettings({
				apiKey: 'custom-key',
				baseUrl: 'http://remote:11434/v1'
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
			expect(health.message).toBe('Ollama plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VllmPlugin } from '../vllm.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(() => ({
		createChatCompletion: vi.fn().mockResolvedValue({ id: 'test', choices: [], model: 'local-model', created: 0 }),
		createStreamingChatCompletion: vi.fn(),
		createEmbedding: vi.fn(),
		askJson: vi.fn().mockResolvedValue({ result: {}, model: 'local-model', usage: undefined }),
		listModels: vi.fn().mockResolvedValue([]),
		testConnection: vi.fn().mockResolvedValue({ success: true })
	}));
	return { AiOperations: MockAiOperations };
});

describe('VllmPlugin', () => {
	let plugin: VllmPlugin;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = new VllmPlugin();
	});

	describe('metadata', () => {
		it('should have correct plugin id and name', () => {
			expect(plugin.id).toBe('vllm');
			expect(plugin.name).toBe('vLLM');
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
		it('should have required baseUrl and defaultModel fields', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
			expect(plugin.settingsSchema.required).toEqual(['baseUrl', 'defaultModel']);
		});

		it('should have apiKey as an encrypted secret with EMPTY default', () => {
			const apiKeySchema = plugin.settingsSchema.properties?.apiKey as any;
			expect(apiKeySchema).toBeDefined();
			expect(apiKeySchema.type).toBe('string');
			expect(apiKeySchema.default).toBe('EMPTY');
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

		it('should NOT hardcode a default model (populated via model-select)', () => {
			const props = plugin.settingsSchema.properties!;
			expect((props.defaultModel as any).default).toBeUndefined();
			expect((props.defaultModel as any)['x-widget']).toBe('model-select');
		});

		it('should have baseUrl setting with the vLLM title', () => {
			const props = plugin.settingsSchema.properties!;
			expect(props).toHaveProperty('baseUrl');
			expect((props.baseUrl as any).type).toBe('string');
			expect((props.baseUrl as any).title).toBe('vLLM Server URL');
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

	describe('lifecycle hooks', () => {
		const createMockContext = (): PluginContext =>
			({
				pluginId: 'vllm',
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('vLLM Plugin loaded');
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
			expect(manifest.id).toBe('vllm');
			expect(manifest.name).toBe('vLLM');
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
			expect(health.message).toBe('vLLM plugin is ready');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('askJson', () => {
		const createMockContext2 = (): PluginContext =>
			({
				pluginId: 'vllm',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should delegate to aiOps.askJson with resolved config', async () => {
			await plugin.onLoad(createMockContext2());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.askJson('Generate JSON', {
				settings: { apiKey: 'EMPTY' }
			});

			expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
				'Generate JSON',
				expect.any(Object),
				expect.objectContaining({ apiKey: 'EMPTY' }),
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
				pluginId: 'vllm',
				logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
				getSettings: vi.fn().mockResolvedValue({})
			}) as unknown as PluginContext;

		it('should pass settings as configOverrides to AiOperations.listModels', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.listModels({ baseUrl: 'http://custom:8000/v1' });

			expect(aiOpsInstance.listModels).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: 'http://custom:8000/v1' })
			);
		});

		it('should pass settings as configOverrides to AiOperations.testConnection', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.isAvailable({ baseUrl: 'http://custom:8000/v1' });

			expect(aiOpsInstance.testConnection).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: 'http://custom:8000/v1' })
			);
		});

		it('should pass resolved settings (URL, key, embedding model) to AiOperations.createEmbedding', async () => {
			await plugin.onLoad(createMockContext());
			const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

			await plugin.createEmbedding({
				input: 'hello',
				settings: {
					baseUrl: 'http://custom:8000/v1',
					apiKey: 'sk-vllm-token',
					embeddingModel: 'intfloat/e5-mistral-7b-instruct'
				}
			});

			expect(aiOpsInstance.createEmbedding).toHaveBeenCalledWith(
				expect.objectContaining({ input: 'hello' }),
				expect.objectContaining({
					baseURL: 'http://custom:8000/v1',
					apiKey: 'sk-vllm-token',
					embeddingModel: 'intfloat/e5-mistral-7b-instruct'
				})
			);
		});
	});
});

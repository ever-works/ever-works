import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrokPlugin } from '../grok.plugin';
import type { PluginContext } from '@ever-works/plugin';
import { AiOperations } from '@ever-works/plugin/ai';

vi.mock('@ever-works/plugin/ai', () => {
	const MockAiOperations = vi.fn().mockImplementation(() => ({
		createChatCompletion: vi.fn().mockResolvedValue({ id: 'test', choices: [], model: 'grok', created: 0 }),
		createStreamingChatCompletion: vi.fn(),
		createEmbedding: vi.fn(),
		askJson: vi.fn().mockResolvedValue({ result: {}, model: 'grok', usage: undefined }),
		listModels: vi.fn().mockResolvedValue([]),
		testConnection: vi.fn().mockResolvedValue({ success: true })
	}));
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

		it('should default to grok-2-latest across model tiers', () => {
			const props = plugin.settingsSchema.properties!;
			expect((props.defaultModel as { default: string }).default).toBe('grok-2-latest');
			expect((props.simpleModel as { default: string }).default).toBe('grok-2-latest');
			expect((props.mediumModel as { default: string }).default).toBe('grok-2-latest');
			expect((props.complexModel as { default: string }).default).toBe('grok-2-latest');
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
			await expect(plugin.createEmbedding({ input: 'hi' } as never)).rejects.toThrow('Embeddings not supported by Grok');
		});
	});
});

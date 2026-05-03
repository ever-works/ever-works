import { Test, TestingModule } from '@nestjs/testing';
import { z } from 'zod';
import { AiFacadeService, AiFacadeError } from '../ai.facade';
import { NoProviderError, ProviderNotFoundError } from '../base.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type {
    IAiProviderPlugin,
    PluginManifest,
    ChatCompletionResponse,
    AiModelCapabilities,
} from '@ever-works/plugin';

describe('AiFacadeService', () => {
    let service: AiFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const defaultFacadeOptions = { userId: 'test-user' };

    const mockCapabilities: AiModelCapabilities = {
        supportsStructuredOutput: true,
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsVision: false,
        maxContextLength: 128000,
    };

    const createMockAiPlugin = (
        id: string,
        providerName: string,
        opts?: { withAskJson?: boolean; providerType?: string },
    ): IAiProviderPlugin => ({
        id,
        name: `${providerName} Plugin`,
        version: '1.0.0',
        category: 'ai-provider',
        capabilities: ['ai-provider'],
        settingsSchema: { type: 'object', properties: {} },
        providerType: opts?.providerType ?? 'openai',
        providerName,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        isAvailable: jest.fn().mockResolvedValue(true),
        createChatCompletion: jest.fn().mockResolvedValue({
            id: 'test-id',
            created: Date.now(),
            model: 'gpt-4',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: '{"name": "test"}' },
                    finishReason: 'stop',
                },
            ],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        } as ChatCompletionResponse),
        ...(opts?.withAskJson !== false && {
            askJson: jest.fn().mockResolvedValue({
                result: { name: 'test' },
                model: 'gpt-4',
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            }),
        }),
        createStreamingChatCompletion: jest.fn().mockReturnValue(
            (async function* () {
                yield {
                    id: 'test-chunk',
                    model: 'gpt-4',
                    created: Date.now(),
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: 'test' },
                            finishReason: null,
                        },
                    ],
                };
                yield {
                    id: 'test-chunk',
                    model: 'gpt-4',
                    created: Date.now(),
                    choices: [{ index: 0, delta: {}, finishReason: 'stop' }],
                };
            })(),
        ),
        listModels: jest.fn().mockResolvedValue([]),
        getModel: jest.fn().mockResolvedValue(null),
        getCapabilities: jest.fn().mockReturnValue(mockCapabilities),
    });

    const createRegisteredPlugin = (
        plugin: IAiProviderPlugin,
        manifest: Partial<PluginManifest>,
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test plugin',
            category: plugin.category,
            capabilities: manifest.capabilities || plugin.capabilities,
            systemPlugin: manifest.systemPlugin,
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AiFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest.fn().mockResolvedValue({}),
                    },
                },
            ],
        }).compile();

        service = module.get<AiFacadeService>(AiFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('isConfigured', () => {
        it('should return true when AI provider plugin is enabled', () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(true);
        });

        it('should return false when no AI provider plugins exist', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(service.isConfigured()).toBe(false);
        });

        it('should return false when AI provider plugin is not enabled', () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(
                aiPlugin,
                { capabilities: ['ai-provider'] },
                'unloaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of available AI providers', () => {
            const openai = createMockAiPlugin('openai-provider', 'OpenAI');
            const anthropic = createMockAiPlugin('anthropic-provider', 'Anthropic');

            const openaiRegistered = createRegisteredPlugin(openai, {
                capabilities: ['ai-provider'],
            });
            const anthropicRegistered = createRegisteredPlugin(
                anthropic,
                { capabilities: ['ai-provider'] },
                'unloaded',
            );

            registry.getByCapability.mockReturnValue([openaiRegistered, anthropicRegistered]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'openai-provider',
                name: 'OpenAI',
                enabled: true,
            });
            expect(providers[1]).toEqual({
                id: 'anthropic-provider',
                name: 'Anthropic',
                enabled: false,
            });
        });

        it('should return empty array when no providers exist', () => {
            registry.getByCapability.mockReturnValue([]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(0);
        });
    });

    describe('askJson', () => {
        const testSchema = z.object({ name: z.string() });
        const originalFetch = global.fetch;

        afterEach(() => {
            global.fetch = originalFetch;
        });

        it('should use plugin.askJson for efficient structured output', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.askJson(
                'Extract name: {text}',
                testSchema,
                { variables: { text: 'Hello John' } },
                defaultFacadeOptions,
            );

            expect(result.result).toEqual({ name: 'test' });
            expect(result.provider).toBe('openai-provider');
            expect(result.model).toBe('gpt-4');
            expect(aiPlugin.askJson).toHaveBeenCalled();
            expect(aiPlugin.createChatCompletion).not.toHaveBeenCalled();
        });

        it('should fall back to createChatCompletion when plugin has no askJson', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI', {
                withAskJson: false,
            });
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.askJson(
                'Extract name: {text}',
                testSchema,
                { variables: { text: 'Hello John' } },
                defaultFacadeOptions,
            );

            expect(result.result).toEqual({ name: 'test' });
            expect(aiPlugin.createChatCompletion).toHaveBeenCalled();
        });

        it('should throw NoProviderError when no provider is configured', async () => {
            registry.getByCapability.mockReturnValue([]);

            await expect(
                service.askJson('Test prompt', testSchema, undefined, defaultFacadeOptions),
            ).rejects.toThrow(NoProviderError);
        });

        it('should throw ProviderNotFoundError for invalid provider override', async () => {
            registry.get.mockReturnValue(undefined);

            await expect(
                service.askJson(
                    'Test prompt',
                    testSchema,
                    { routing: { providerOverride: 'non-existent' } },
                    defaultFacadeOptions,
                ),
            ).rejects.toThrow(ProviderNotFoundError);
        });

        it('should use provider override when specified', async () => {
            const openai = createMockAiPlugin('openai-provider', 'OpenAI');
            const anthropic = createMockAiPlugin('anthropic-provider', 'Anthropic');

            const openaiRegistered = createRegisteredPlugin(openai, {
                capabilities: ['ai-provider'],
            });
            const anthropicRegistered = createRegisteredPlugin(anthropic, {
                capabilities: ['ai-provider'],
            });

            registry.getByCapability.mockReturnValue([openaiRegistered, anthropicRegistered]);
            registry.get.mockReturnValue(anthropicRegistered);

            await service.askJson(
                'Test',
                testSchema,
                { routing: { providerOverride: 'anthropic-provider' } },
                defaultFacadeOptions,
            );

            expect(anthropic.askJson).toHaveBeenCalled();
            expect(openai.askJson).not.toHaveBeenCalled();
        });

        it('should throw AiFacadeError when fallback response is not valid JSON', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI', {
                withAskJson: false,
            });
            (aiPlugin.createChatCompletion as jest.Mock).mockResolvedValue({
                choices: [{ message: { content: 'invalid json' } }],
                model: 'gpt-4',
            });

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.askJson('Test', testSchema, undefined, defaultFacadeOptions),
            ).rejects.toThrow(AiFacadeError);
        });

        it('should throw AiFacadeError when response does not match schema', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.askJson as jest.Mock).mockResolvedValue({
                result: { wrong: 'field' },
                model: 'gpt-4',
            });

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.askJson('Test', testSchema, undefined, defaultFacadeOptions),
            ).rejects.toThrow(AiFacadeError);
        });

        it('should return usage information when available', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.askJson(
                'Test',
                testSchema,
                undefined,
                defaultFacadeOptions,
            );

            expect(result.usage).toEqual({
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
            });
        });

        it('should calculate cost when model pricing is available', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            // Mock getModel to return pricing info
            (aiPlugin.getModel as jest.Mock).mockResolvedValue({
                id: 'gpt-4',
                name: 'GPT-4',
                capabilities: mockCapabilities,
                inputCostPer1k: 0.03, // $0.03 per 1K input tokens
                outputCostPer1k: 0.06, // $0.06 per 1K output tokens
            });

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.askJson(
                'Test',
                testSchema,
                undefined,
                defaultFacadeOptions,
            );

            // Cost = (10 * 0.03 / 1000) + (5 * 0.06 / 1000) = 0.0003 + 0.0003 = 0.0006
            expect(result.cost).toBeCloseTo(0.0006, 6);
        });

        it('should return null cost when model pricing is not available', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('No catalog metadata'));

            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            // getModel returns null (default mock)
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.askJson(
                'Test',
                testSchema,
                undefined,
                defaultFacadeOptions,
            );

            expect(result.cost).toBeNull();
        });

        it('should fall back to catalog pricing when plugin model metadata is missing', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        data: [
                            {
                                id: 'openai/gpt-4',
                                name: 'GPT-4',
                                context_length: 128000,
                                pricing: { prompt: '0.00003', completion: '0.00006' },
                            },
                        ],
                    }),
            });

            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.askJson(
                'Test',
                testSchema,
                undefined,
                defaultFacadeOptions,
            );

            expect(result.cost).toBeCloseTo(0.0006, 6);
        });

        it('should auto-escalate from simple to medium on failure', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.askJson as jest.Mock)
                .mockRejectedValueOnce(new Error('Rate limit'))
                .mockResolvedValueOnce({
                    result: { name: 'escalated' },
                    model: 'gpt-4',
                    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
                });

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);
            settingsService.getSettings.mockResolvedValue({
                simpleModel: 'gpt-3.5-turbo',
                mediumModel: 'gpt-4',
                complexModel: 'gpt-4-turbo',
            });

            const result = await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'simple' } },
                defaultFacadeOptions,
            );

            expect(result.result).toEqual({ name: 'escalated' });
            expect(aiPlugin.askJson).toHaveBeenCalledTimes(2);
            // Second call should use the escalated model
            expect(aiPlugin.askJson).toHaveBeenLastCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4' }),
            );
        });

        it('should not auto-escalate when autoEscalate is false', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.askJson as jest.Mock).mockRejectedValue(new Error('Rate limit'));

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);
            settingsService.getSettings.mockResolvedValue({
                simpleModel: 'gpt-3.5-turbo',
                mediumModel: 'gpt-4',
            });

            await expect(
                service.askJson(
                    'Test',
                    testSchema,
                    { routing: { complexity: 'simple', autoEscalate: false } },
                    defaultFacadeOptions,
                ),
            ).rejects.toThrow('Rate limit');

            expect(aiPlugin.askJson).toHaveBeenCalledTimes(1);
        });
    });

    describe('provider resolution with active work provider', () => {
        const testSchema = z.object({ name: z.string() });

        it('should use work active provider when set', async () => {
            const openaiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const anthropicPlugin = createMockAiPlugin('anthropic-provider', 'Anthropic');

            const openaiRegistered = createRegisteredPlugin(openaiPlugin, {
                capabilities: ['ai-provider'],
            });
            const anthropicRegistered = createRegisteredPlugin(anthropicPlugin, {
                capabilities: ['ai-provider'],
            });

            registry.getByCapability.mockReturnValue([openaiRegistered, anthropicRegistered]);
            registry.get.mockReturnValue(anthropicRegistered);

            // Import WorkPluginRepository to mock it
            const {
                WorkPluginRepository,
            } = require('../../plugins/repositories/work-plugin.repository');
            const mockDirRepo = {
                findActiveByCapability: jest.fn().mockResolvedValue({
                    pluginId: 'anthropic-provider',
                    capability: 'ai-provider',
                }),
            };

            // Recreate service with mocked work repository
            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    AiFacadeService,
                    {
                        provide: PluginRegistryService,
                        useValue: registry,
                    },
                    {
                        provide: PluginSettingsService,
                        useValue: settingsService,
                    },
                    {
                        provide: WorkPluginRepository,
                        useValue: mockDirRepo,
                    },
                ],
            }).compile();

            const serviceWithDirRepo = module.get<AiFacadeService>(AiFacadeService);

            await serviceWithDirRepo.askJson(
                'Test',
                testSchema,
                {},
                { workId: 'dir-123', userId: 'user-456' },
            );

            // Anthropic should be used because it's the active provider for the work
            expect(anthropicPlugin.askJson).toHaveBeenCalled();
            expect(openaiPlugin.askJson).not.toHaveBeenCalled();
        });

        it('should fall back to first enabled provider when no work active provider', async () => {
            const openaiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const anthropicPlugin = createMockAiPlugin('anthropic-provider', 'Anthropic');

            const openaiRegistered = createRegisteredPlugin(openaiPlugin, {
                capabilities: ['ai-provider'],
            });
            const anthropicRegistered = createRegisteredPlugin(anthropicPlugin, {
                capabilities: ['ai-provider'],
            });

            registry.getByCapability.mockReturnValue([openaiRegistered, anthropicRegistered]);
            settingsService.getSettings.mockResolvedValue({});

            await service.askJson(
                'Test',
                testSchema,
                {},
                { workId: 'dir-123', userId: 'user-456' },
            );

            // First provider (OpenAI) should be used when no active provider set
            expect(openaiPlugin.askJson).toHaveBeenCalled();
        });

        it('should use provider override when specified', async () => {
            const openaiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const anthropicPlugin = createMockAiPlugin('anthropic-provider', 'Anthropic');

            const openaiRegistered = createRegisteredPlugin(openaiPlugin, {
                capabilities: ['ai-provider'],
            });
            const anthropicRegistered = createRegisteredPlugin(anthropicPlugin, {
                capabilities: ['ai-provider'],
            });

            registry.getByCapability.mockReturnValue([openaiRegistered, anthropicRegistered]);
            registry.get.mockReturnValue(anthropicRegistered);

            await service.askJson(
                'Test',
                testSchema,
                { routing: { providerOverride: 'anthropic-provider' } },
                { workId: 'dir-123', userId: 'user-456' },
            );

            // Anthropic should be used because of provider override
            expect(anthropicPlugin.askJson).toHaveBeenCalled();
            expect(openaiPlugin.askJson).not.toHaveBeenCalled();
        });
    });

    describe('testConnection', () => {
        it('should return success when provider is available', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.testConnection(defaultFacadeOptions);

            expect(result.success).toBe(true);
            expect(result.provider).toBe('openai-provider');
            expect(result.responseTime).toBeGreaterThanOrEqual(0);
        });

        it('should return failure when provider is not available', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.isAvailable as jest.Mock).mockResolvedValue(false);

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.testConnection(defaultFacadeOptions);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Provider not available');
        });

        it('should return failure when no provider exists', async () => {
            registry.getByCapability.mockReturnValue([]);

            const result = await service.testConnection(defaultFacadeOptions);

            expect(result.success).toBe(false);
            expect(result.error).toContain('No ai-provider provider');
        });

        it('should resolve settings and pass to plugin.isAvailable', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);
            settingsService.getSettings.mockResolvedValue({ apiKey: 'test-key' });

            await service.testConnection({ userId: 'user-1' });

            expect(aiPlugin.isAvailable).toHaveBeenCalledWith(
                expect.objectContaining({ apiKey: 'test-key' }),
            );
        });
    });

    describe('model routing', () => {
        const testSchema = z.object({ name: z.string() });

        it('should use modelOverride when specified', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await service.askJson(
                'Test',
                testSchema,
                { routing: { modelOverride: 'gpt-4-turbo' } },
                defaultFacadeOptions,
            );

            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4-turbo' }),
            );
        });

        it('should use complexity-based model from settings', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            // Settings with complexity-based models
            settingsService.getSettings.mockResolvedValue({
                simpleModel: 'gpt-3.5-turbo',
                mediumModel: 'gpt-4',
                complexModel: 'gpt-4-turbo',
            });

            await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'simple' } },
                defaultFacadeOptions,
            );

            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-3.5-turbo' }),
            );
        });

        it('should use mediumModel for medium complexity tasks', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            settingsService.getSettings.mockResolvedValue({
                simpleModel: 'gpt-3.5-turbo',
                mediumModel: 'gpt-4',
                complexModel: 'gpt-4-turbo',
            });

            await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'medium' } },
                defaultFacadeOptions,
            );

            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4' }),
            );
        });

        it('should use complexModel for complex tasks', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            settingsService.getSettings.mockResolvedValue({
                simpleModel: 'gpt-3.5-turbo',
                mediumModel: 'gpt-4',
                complexModel: 'gpt-4-turbo',
            });

            await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'complex' } },
                defaultFacadeOptions,
            );

            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4-turbo' }),
            );
        });

        it('should use defaultModel when no complexity specified', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            settingsService.getSettings.mockResolvedValue({
                defaultModel: 'gpt-4',
            });

            await service.askJson('Test', testSchema, undefined, defaultFacadeOptions);

            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4' }),
            );
        });

        it('should fall back to plugin default when no settings', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);
            settingsService.getSettings.mockResolvedValue({});

            await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'medium' } },
                defaultFacadeOptions,
            );

            // Model should be undefined, plugin uses its default
            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: undefined }),
            );
        });

        it('should prioritize modelOverride over complexity-based routing', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            settingsService.getSettings.mockResolvedValue({
                simpleModel: 'gpt-3.5-turbo',
            });

            await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'simple', modelOverride: 'gpt-4o' } },
                defaultFacadeOptions,
            );

            // modelOverride should win over complexity
            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4o' }),
            );
        });

        it('should use defaultModel when complexity not in settings', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            settingsService.getSettings.mockResolvedValue({
                defaultModel: 'gpt-4',
                // Note: no simpleModel defined
            });

            await service.askJson(
                'Test',
                testSchema,
                { routing: { complexity: 'simple' } },
                defaultFacadeOptions,
            );

            // Falls through to defaultModel
            expect(aiPlugin.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ model: 'gpt-4' }),
            );
        });
    });

    describe('resolveModelContextLength', () => {
        const originalFetch = global.fetch;

        afterEach(() => {
            global.fetch = originalFetch;
        });

        const mockOpenRouterData = [
            { id: 'openai/gpt-4o', context_length: 128000 },
            { id: 'google/gemini-2.5-flash', context_length: 1048576 },
            { id: 'qwen/qwen3-32b', context_length: 40960 },
        ];

        it('should return context length when OpenRouter match found', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: mockOpenRouterData }),
            });

            const result = await service.resolveModelContextLength('gpt-4o', defaultFacadeOptions);
            expect(result).toBe(128000);
        });

        it('should return context length for fuzzy base-name match', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: mockOpenRouterData }),
            });

            const result = await service.resolveModelContextLength(
                'models/gemini-2.5-flash',
                defaultFacadeOptions,
            );
            expect(result).toBe(1048576);
        });

        it('should fall back to 128K when no match found', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: mockOpenRouterData }),
            });

            const result = await service.resolveModelContextLength(
                'nonexistent-model',
                defaultFacadeOptions,
            );
            expect(result).toBe(128_000);
        });

        it('should fall back to 128K when fetch fails', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

            const result = await service.resolveModelContextLength('gpt-4o', defaultFacadeOptions);
            expect(result).toBe(128_000);
        });

        it('should cache catalog responses (second call does not refetch)', async () => {
            global.fetch = jest
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ data: mockOpenRouterData }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({}),
                });

            await service.resolveModelContextLength('gpt-4o', defaultFacadeOptions);
            await service.resolveModelContextLength('qwen3-32b', defaultFacadeOptions);

            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        it('should never throw even on unexpected errors', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () => {
                    throw new Error('Parse explosion');
                },
            });

            const result = await service.resolveModelContextLength('gpt-4o', defaultFacadeOptions);
            expect(result).toBe(128_000);
        });
    });

    describe('resolveModelMetadata', () => {
        const originalFetch = global.fetch;

        afterEach(() => {
            global.fetch = originalFetch;
        });

        it('should merge catalog context and pricing into plugin models', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        data: [
                            {
                                id: 'openai/gpt-4o',
                                name: 'GPT-4o',
                                context_length: 200000,
                                pricing: { prompt: '0.000005', completion: '0.000015' },
                            },
                        ],
                    }),
            });

            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.getModel as jest.Mock).mockResolvedValue({
                id: 'gpt-4o',
                name: 'GPT-4o',
                capabilities: mockCapabilities,
            });

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const model = await service.resolveModelMetadata('gpt-4o', defaultFacadeOptions);

            expect(model).toMatchObject({
                id: 'gpt-4o',
                name: 'GPT-4o',
                capabilities: {
                    ...mockCapabilities,
                    maxContextLength: 200000,
                },
                inputCostPer1k: 0.005,
            });
            expect(model?.outputCostPer1k).toBeCloseTo(0.015, 12);
        });

        it('should fall back to models.dev when OpenRouter metadata is unavailable', async () => {
            global.fetch = jest
                .fn()
                .mockRejectedValueOnce(new Error('OpenRouter down'))
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            openai: {
                                id: 'openai',
                                name: 'OpenAI',
                                models: {
                                    'gpt-5.1': {
                                        id: 'gpt-5.1',
                                        name: 'GPT-5.1',
                                        cost: { input: 1.25, output: 10 },
                                        limit: { context: 400000, output: 128000 },
                                    },
                                },
                            },
                        }),
                });

            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const model = await service.resolveModelMetadata('gpt-5.1', defaultFacadeOptions);

            expect(model).toEqual({
                id: 'openai/gpt-5.1',
                name: 'GPT-5.1',
                capabilities: {
                    ...mockCapabilities,
                    maxContextLength: 400000,
                    maxOutputTokens: 128000,
                },
                inputCostPer1k: 0.00125,
                outputCostPer1k: 0.01,
            });
        });

        it('should preserve plugin-specific context length when catalog entry lacks one', async () => {
            global.fetch = jest
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            data: [
                                {
                                    id: 'openai/gpt-4o',
                                    name: 'GPT-4o',
                                    pricing: { prompt: '0.000005', completion: '0.000015' },
                                },
                            ],
                        }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({}),
                });

            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.getModel as jest.Mock).mockResolvedValue({
                id: 'gpt-4o',
                name: 'GPT-4o',
                capabilities: {
                    ...mockCapabilities,
                    maxContextLength: 32768,
                },
            });

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const model = await service.resolveModelMetadata('gpt-4o', defaultFacadeOptions);

            expect(model).toMatchObject({
                id: 'gpt-4o',
                capabilities: {
                    ...mockCapabilities,
                    maxContextLength: 32768,
                },
                inputCostPer1k: 0.005,
            });
            expect(model?.outputCostPer1k).toBeCloseTo(0.015, 12);
        });
    });

    describe('getAvailableModels', () => {
        it('should return models from AI provider', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.listModels as jest.Mock).mockResolvedValue([
                { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', capabilities: mockCapabilities },
                { id: 'gpt-4', name: 'GPT-4', capabilities: mockCapabilities },
                { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', capabilities: mockCapabilities },
            ]);

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const models = await service.getAvailableModels(defaultFacadeOptions);

            expect(models).toHaveLength(3);
            expect(models[0].id).toBe('gpt-3.5-turbo');
            expect(models[1].id).toBe('gpt-4');
            expect(models[2].id).toBe('gpt-4-turbo');
        });

        it('should return empty array when no provider exists', async () => {
            registry.getByCapability.mockReturnValue([]);

            const models = await service.getAvailableModels(defaultFacadeOptions);

            expect(models).toHaveLength(0);
        });

        it('should return empty array when listModels fails', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.listModels as jest.Mock).mockRejectedValue(new Error('API error'));

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const models = await service.getAvailableModels(defaultFacadeOptions);

            expect(models).toHaveLength(0);
        });

        it('should resolve settings and pass to plugin.listModels', async () => {
            const aiPlugin = createMockAiPlugin('openai-provider', 'OpenAI');
            (aiPlugin.listModels as jest.Mock).mockResolvedValue([]);

            const registered = createRegisteredPlugin(aiPlugin, {
                capabilities: ['ai-provider'],
            });
            registry.getByCapability.mockReturnValue([registered]);
            settingsService.getSettings.mockResolvedValue({ apiKey: 'test-key' });

            await service.getAvailableModels({ userId: 'user-1' });

            expect(aiPlugin.listModels).toHaveBeenCalledWith(
                expect.objectContaining({ apiKey: 'test-key' }),
            );
        });
    });
});

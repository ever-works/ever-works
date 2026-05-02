import { Test, TestingModule } from '@nestjs/testing';
import { PromptFacadeService } from '../prompt.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { IPromptProviderPlugin, PluginManifest } from '@ever-works/plugin';

describe('PromptFacadeService', () => {
    let service: PromptFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const DEFAULT_PROMPT = 'You are an assistant. Topic: {name}';
    const facadeOptions = { userId: 'user-1', workId: 'dir-1' };

    const createMockPlugin = (
        overrides?: Partial<IPromptProviderPlugin>,
    ): IPromptProviderPlugin => ({
        id: 'langfuse',
        name: 'Langfuse',
        version: '1.0.0',
        category: 'utility',
        capabilities: ['prompt-provider'],
        settingsSchema: { type: 'object', properties: {} },
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        isAvailable: jest.fn().mockReturnValue(true),
        getPrompt: jest.fn().mockResolvedValue(null),
        ...overrides,
    });

    const createRegisteredPlugin = (plugin: IPromptProviderPlugin): RegisteredPlugin => ({
        plugin,
        state: 'loaded',
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Prompt provider',
            category: 'utility',
            capabilities: ['prompt-provider'],
        } as PluginManifest,
        builtIn: true,
        registeredAt: Date.now(),
        loadedAt: Date.now(),
        stateHistory: [],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PromptFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        getByCapability: jest.fn().mockReturnValue([]),
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

        service = module.get(PromptFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('getPrompt', () => {
        it('should return the default prompt when no provider is registered', async () => {
            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe(DEFAULT_PROMPT);
        });

        it('should return the default prompt when the provider is not available', async () => {
            const plugin = createMockPlugin({ isAvailable: jest.fn().mockReturnValue(false) });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe(DEFAULT_PROMPT);
        });

        it('should return the default prompt when the prompt key is not found', async () => {
            const plugin = createMockPlugin({ getPrompt: jest.fn().mockResolvedValue(null) });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('unknown.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe(DEFAULT_PROMPT);
        });

        it('should return the default prompt on provider error', async () => {
            const plugin = createMockPlugin({
                getPrompt: jest.fn().mockRejectedValue(new Error('Network failure')),
            });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe(DEFAULT_PROMPT);
        });

        it('should return the provider prompt when available', async () => {
            const providerTemplate = 'Custom prompt from Langfuse. Topic: {name}';
            const plugin = createMockPlugin({
                getPrompt: jest.fn().mockResolvedValue({ template: providerTemplate, version: 3 }),
            });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe(providerTemplate);
        });

        it('should normalize {{var}} to {var} in provider templates', async () => {
            const plugin = createMockPlugin({
                getPrompt: jest.fn().mockResolvedValue({
                    template: 'Hello {{name}}, welcome to {{topic}}!',
                    version: 1,
                }),
            });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe('Hello {name}, welcome to {topic}!');
        });

        it('should preserve existing {var} syntax in provider templates', async () => {
            const plugin = createMockPlugin({
                getPrompt: jest.fn().mockResolvedValue({
                    template: 'Hello {name}, you have {{count}} messages',
                    version: 1,
                }),
            });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe('Hello {name}, you have {count} messages');
        });

        it('should resolve settings with secrets for the provider plugin', async () => {
            const plugin = createMockPlugin({
                getPrompt: jest.fn().mockResolvedValue({ template: 'resolved', version: 1 }),
            });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);

            expect(settingsService.getSettings).toHaveBeenCalledWith('langfuse', {
                userId: 'user-1',
                workId: 'dir-1',
                includeSecrets: true,
            });
        });

        it('should work without facadeOptions', async () => {
            const plugin = createMockPlugin({
                getPrompt: jest.fn().mockResolvedValue({ template: 'resolved', version: 1 }),
            });
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT);
            expect(result).toBe('resolved');
            expect(settingsService.getSettings).not.toHaveBeenCalled();
        });

        it('should skip plugins that are not in loaded state', async () => {
            const plugin = createMockPlugin();
            const registered = createRegisteredPlugin(plugin);
            (registered as any).state = 'error';
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getPrompt('test.key', DEFAULT_PROMPT, facadeOptions);
            expect(result).toBe(DEFAULT_PROMPT);
        });
    });

    describe('isConfigured', () => {
        it('should return false when no provider is registered', () => {
            expect(service.isConfigured()).toBe(false);
        });

        it('should return true when a loaded provider exists', () => {
            const plugin = createMockPlugin();
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(plugin)]);
            expect(service.isConfigured()).toBe(true);
        });
    });
});

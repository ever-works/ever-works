import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { ProviderOverrideService, ProviderOverrideContext } from '../provider-override.service';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';

// Silence logger during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

import type {
    ISubProviderPlugin,
    IPlugin,
    PluginManifest,
    PluginCategory,
    SubProviderRegistration,
} from '@ever-works/plugin';

describe('ProviderOverrideService', () => {
    let service: ProviderOverrideService;
    let registry: PluginRegistryService;

    /**
     * Creates a mock sub-provider plugin
     */
    const createMockSubProvider = (
        id: string,
        options: {
            subProviderId?: string;
            parentCapability?: string;
            canHandle?: boolean;
            priority?: number;
            isDefault?: boolean;
            isAvailable?: boolean;
            canHandleError?: Error;
        } = {},
    ): ISubProviderPlugin => {
        const {
            subProviderId = `${id}-sub`,
            parentCapability = 'ai-provider',
            canHandle = true,
            priority = 10,
            isDefault = false,
            isAvailable = true,
            canHandleError,
        } = options;

        return {
            id,
            name: `Mock Provider ${id}`,
            version: '1.0.0',
            category: 'utility' as PluginCategory,
            capabilities: ['sub-provider'],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn(),
            onEnable: jest.fn(),
            onDisable: jest.fn(),
            onUnload: jest.fn(),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            subProviderId,
            parentCapability,
            canHandle: jest.fn().mockImplementation(() => {
                if (canHandleError) throw canHandleError;
                return Promise.resolve(canHandle);
            }),
            getPriority: jest.fn().mockReturnValue(priority),
            isAvailable: jest.fn().mockResolvedValue(isAvailable),
            getRegistration: jest.fn().mockReturnValue({
                id: `${id}-registration`,
                subProviderId,
                parentCapability,
                name: `Provider ${id}`,
                description: 'Test provider',
                priority,
                isDefault,
            } as SubProviderRegistration),
            execute: jest.fn(),
        } as unknown as ISubProviderPlugin;
    };

    const createMockManifest = (id: string): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: 'utility' as PluginCategory,
        capabilities: ['sub-provider'],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ProviderOverrideService,
                PluginRegistryService,
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                        on: jest.fn(),
                        off: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<ProviderOverrideService>(ProviderOverrideService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
    });

    afterEach(() => {
        registry.clear();
        jest.clearAllMocks();
    });

    describe('getProviderForStep()', () => {
        it('should return null when no sub-providers enabled', async () => {
            const context: ProviderOverrideContext = {
                operation: 'categorization',
                directoryId: 'dir-123',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBeNull();
            expect(result.reason).toBe('No sub-provider plugins enabled');
        });

        it('should return provider that can handle operation', async () => {
            const provider = createMockSubProvider('openai', { canHandle: true });
            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'categorization',
                directoryId: 'dir-123',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBe(provider);
            expect(provider.canHandle).toHaveBeenCalledWith({
                directoryId: 'dir-123',
                userId: undefined,
                operation: 'categorization',
                data: undefined,
            });
        });

        it('should return null when no provider can handle operation', async () => {
            const provider = createMockSubProvider('openai', { canHandle: false });
            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBeNull();
            expect(result.reason).toContain('No sub-providers can handle operation');
        });

        it('should select provider with lowest priority', async () => {
            const provider1 = createMockSubProvider('openai', { priority: 20, canHandle: true });
            const provider2 = createMockSubProvider('anthropic', { priority: 5, canHandle: true });
            const provider3 = createMockSubProvider('google', { priority: 15, canHandle: true });

            registry.register(provider1 as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(provider2 as unknown as IPlugin, createMockManifest('anthropic'), {
                state: 'enabled',
            });
            registry.register(provider3 as unknown as IPlugin, createMockManifest('google'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBe(provider2);
            expect(result.priority).toBe(5);
        });

        it('should pass context data to canHandle', async () => {
            const provider = createMockSubProvider('openai', { canHandle: true });
            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'categorization',
                directoryId: 'dir-123',
                userId: 'user-456',
                data: { customField: 'value' },
            };

            await service.getProviderForStep(context);

            expect(provider.canHandle).toHaveBeenCalledWith({
                directoryId: 'dir-123',
                userId: 'user-456',
                operation: 'categorization',
                data: { customField: 'value' },
            });
        });

        it('should handle canHandle errors gracefully', async () => {
            const errorProvider = createMockSubProvider('error-provider', {
                canHandleError: new Error('Provider check failed'),
            });
            const workingProvider = createMockSubProvider('working-provider', {
                canHandle: true,
            });

            registry.register(
                errorProvider as unknown as IPlugin,
                createMockManifest('error-provider'),
                { state: 'enabled' },
            );
            registry.register(
                workingProvider as unknown as IPlugin,
                createMockManifest('working-provider'),
                { state: 'enabled' },
            );

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBe(workingProvider);
        });

        it('should not include disabled providers', async () => {
            const enabledProvider = createMockSubProvider('enabled', { canHandle: true });
            const disabledProvider = createMockSubProvider('disabled', {
                canHandle: true,
                priority: 1,
            });

            registry.register(
                enabledProvider as unknown as IPlugin,
                createMockManifest('enabled'),
                { state: 'enabled' },
            );
            registry.register(
                disabledProvider as unknown as IPlugin,
                createMockManifest('disabled'),
                { state: 'loaded' }, // Not enabled
            );

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBe(enabledProvider);
        });
    });

    describe('getProviderByCapability()', () => {
        it('should filter by parent capability', async () => {
            const aiProvider = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
                canHandle: true,
            });
            const searchProvider = createMockSubProvider('tavily', {
                parentCapability: 'search',
                canHandle: true,
            });

            registry.register(aiProvider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(searchProvider as unknown as IPlugin, createMockManifest('tavily'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'web-search',
            };

            const result = await service.getProviderByCapability('search', context);

            expect(result.provider).toBe(searchProvider);
        });

        it('should return null when no providers for capability', async () => {
            const aiProvider = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
            });

            registry.register(aiProvider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'web-search',
            };

            const result = await service.getProviderByCapability('search', context);

            expect(result.provider).toBeNull();
            expect(result.reason).toContain('No sub-providers for capability');
        });

        it('should select by priority within capability', async () => {
            const provider1 = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
                priority: 20,
                canHandle: true,
            });
            const provider2 = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
                priority: 5,
                canHandle: true,
            });

            registry.register(provider1 as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(provider2 as unknown as IPlugin, createMockManifest('anthropic'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderByCapability('ai-provider', context);

            expect(result.provider).toBe(provider2);
            expect(result.priority).toBe(5);
        });

        it('should return null when no providers can handle context', async () => {
            const provider = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
                canHandle: false,
            });

            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderByCapability('ai-provider', context);

            expect(result.provider).toBeNull();
            expect(result.reason).toContain('can handle this context');
        });
    });

    describe('getDefaultProvider()', () => {
        it('should return provider marked as default', () => {
            const defaultProvider = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
                isDefault: true,
                priority: 100,
            });
            const nonDefaultProvider = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
                isDefault: false,
                priority: 1,
            });

            registry.register(
                defaultProvider as unknown as IPlugin,
                createMockManifest('anthropic'),
                { state: 'enabled' },
            );
            registry.register(
                nonDefaultProvider as unknown as IPlugin,
                createMockManifest('openai'),
                { state: 'enabled' },
            );

            const result = service.getDefaultProvider('ai-provider');

            expect(result).toBe(defaultProvider);
        });

        it('should return lowest priority provider when no default', () => {
            const provider1 = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
                priority: 50,
                isDefault: false,
            });
            const provider2 = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
                priority: 10,
                isDefault: false,
            });

            registry.register(provider1 as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(provider2 as unknown as IPlugin, createMockManifest('anthropic'), {
                state: 'enabled',
            });

            const result = service.getDefaultProvider('ai-provider');

            expect(result).toBe(provider2);
        });

        it('should return null when no providers for capability', () => {
            const result = service.getDefaultProvider('ai-provider');

            expect(result).toBeNull();
        });

        it('should use priority 100 as default when not specified', () => {
            const providerWithoutPriority = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
            });
            // Override getRegistration to not include priority
            (providerWithoutPriority.getRegistration as jest.Mock).mockReturnValue({
                subProviderId: 'openai-sub',
                parentCapability: 'ai-provider',
                name: 'OpenAI',
                isDefault: false,
            });

            const providerWithPriority = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
                priority: 50,
            });

            registry.register(
                providerWithoutPriority as unknown as IPlugin,
                createMockManifest('openai'),
                { state: 'enabled' },
            );
            registry.register(
                providerWithPriority as unknown as IPlugin,
                createMockManifest('anthropic'),
                { state: 'enabled' },
            );

            const result = service.getDefaultProvider('ai-provider');

            expect(result).toBe(providerWithPriority);
        });
    });

    describe('getAvailableProviders()', () => {
        it('should return empty map when no providers', () => {
            const result = service.getAvailableProviders();

            expect(result.size).toBe(0);
        });

        it('should group providers by parent capability', () => {
            const aiProvider1 = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
            });
            const aiProvider2 = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
            });
            const searchProvider = createMockSubProvider('tavily', {
                parentCapability: 'search',
            });

            registry.register(aiProvider1 as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(aiProvider2 as unknown as IPlugin, createMockManifest('anthropic'), {
                state: 'enabled',
            });
            registry.register(searchProvider as unknown as IPlugin, createMockManifest('tavily'), {
                state: 'enabled',
            });

            const result = service.getAvailableProviders();

            expect(result.size).toBe(2);
            expect(result.get('ai-provider')).toHaveLength(2);
            expect(result.get('search')).toHaveLength(1);
        });

        it('should sort providers by priority within each group', () => {
            const provider1 = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
                priority: 50,
            });
            const provider2 = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
                priority: 10,
            });
            const provider3 = createMockSubProvider('google', {
                parentCapability: 'ai-provider',
                priority: 30,
            });

            registry.register(provider1 as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(provider2 as unknown as IPlugin, createMockManifest('anthropic'), {
                state: 'enabled',
            });
            registry.register(provider3 as unknown as IPlugin, createMockManifest('google'), {
                state: 'enabled',
            });

            const result = service.getAvailableProviders();
            const aiProviders = result.get('ai-provider')!;

            expect(aiProviders[0]).toBe(provider2); // priority 10
            expect(aiProviders[1]).toBe(provider3); // priority 30
            expect(aiProviders[2]).toBe(provider1); // priority 50
        });

        it('should not include disabled providers', () => {
            const enabledProvider = createMockSubProvider('openai', {
                parentCapability: 'ai-provider',
            });
            const disabledProvider = createMockSubProvider('anthropic', {
                parentCapability: 'ai-provider',
            });

            registry.register(enabledProvider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });
            registry.register(
                disabledProvider as unknown as IPlugin,
                createMockManifest('anthropic'),
                { state: 'loaded' },
            );

            const result = service.getAvailableProviders();

            expect(result.get('ai-provider')).toHaveLength(1);
            expect(result.get('ai-provider')![0]).toBe(enabledProvider);
        });
    });

    describe('isProviderAvailable()', () => {
        it('should return true for available provider', async () => {
            const provider = createMockSubProvider('openai', {
                subProviderId: 'openai-gpt4',
                isAvailable: true,
            });

            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const result = await service.isProviderAvailable('openai-gpt4');

            expect(result).toBe(true);
            expect(provider.isAvailable).toHaveBeenCalled();
        });

        it('should return false for unavailable provider', async () => {
            const provider = createMockSubProvider('openai', {
                subProviderId: 'openai-gpt4',
                isAvailable: false,
            });

            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'enabled',
            });

            const result = await service.isProviderAvailable('openai-gpt4');

            expect(result).toBe(false);
        });

        it('should return false for unknown provider', async () => {
            const result = await service.isProviderAvailable('unknown-provider');

            expect(result).toBe(false);
        });

        it('should return false for disabled provider', async () => {
            const provider = createMockSubProvider('openai', {
                subProviderId: 'openai-gpt4',
                isAvailable: true,
            });

            registry.register(provider as unknown as IPlugin, createMockManifest('openai'), {
                state: 'loaded', // Not enabled
            });

            const result = await service.isProviderAvailable('openai-gpt4');

            expect(result).toBe(false);
        });
    });
});

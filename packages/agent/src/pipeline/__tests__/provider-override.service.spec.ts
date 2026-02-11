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
                state: 'loaded',
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
                state: 'loaded',
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
                state: 'loaded',
            });
            registry.register(provider2 as unknown as IPlugin, createMockManifest('anthropic'), {
                state: 'loaded',
            });
            registry.register(provider3 as unknown as IPlugin, createMockManifest('google'), {
                state: 'loaded',
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
                state: 'loaded',
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
                { state: 'loaded' },
            );
            registry.register(
                workingProvider as unknown as IPlugin,
                createMockManifest('working-provider'),
                { state: 'loaded' },
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
                { state: 'loaded' },
            );
            registry.register(
                disabledProvider as unknown as IPlugin,
                createMockManifest('disabled'),
                { state: 'unloaded' }, // Not loaded
            );

            const context: ProviderOverrideContext = {
                operation: 'categorization',
            };

            const result = await service.getProviderForStep(context);

            expect(result.provider).toBe(enabledProvider);
        });
    });
});

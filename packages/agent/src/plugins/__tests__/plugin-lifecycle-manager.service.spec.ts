import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginLifecycleManagerService } from '../services/plugin-lifecycle-manager.service';
import { PluginRegistryService, RegisteredPlugin } from '../services/plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';
import { CustomCapabilityRegistryService } from '../services/custom-capability-registry.service';
import { PluginEvents } from '../plugins.constants';
import type { IPlugin, PluginContext, PluginManifest } from '@ever-works/plugin';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

describe('PluginLifecycleManagerService', () => {
    let service: PluginLifecycleManagerService;
    let registry: PluginRegistryService;
    let pluginRepository: PluginRepository;
    let eventEmitter: EventEmitter2;
    let customCapabilityRegistry: jest.Mocked<CustomCapabilityRegistryService>;

    const createMockPlugin = (): IPlugin =>
        ({
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['test'],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn().mockResolvedValue(undefined),
            onUnload: jest.fn().mockResolvedValue(undefined),
        }) as unknown as IPlugin;

    const createMockManifest = (): PluginManifest => ({
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
        category: 'utility',
        capabilities: ['test'],
    });

    const mockContext: PluginContext = {
        pluginId: 'test-plugin',
        logger: {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            verbose: jest.fn(),
        },
        cache: {
            get: jest.fn(),
            set: jest.fn(),
            delete: jest.fn(),
            has: jest.fn(),
            clear: jest.fn(),
        },
        http: {
            get: jest.fn(),
            post: jest.fn(),
            put: jest.fn(),
            patch: jest.fn(),
            delete: jest.fn(),
        },
        env: {
            platform: 'ever-works',
            platformVersion: '1.0.0',
            nodeVersion: 'v20.0.0',
            isProduction: false,
            isDevelopment: true,
            isTest: false,
            baseUrl: '',
            apiBaseUrl: '',
            tempDir: '/tmp',
            dataDir: '/data',
            features: new Set(),
        },
        envVars: {
            get: jest.fn(),
            getOrDefault: jest.fn(),
            has: jest.fn(),
            getRequired: jest.fn(),
        },
        services: {
            directory: undefined,
            user: undefined,
        },
        getSettings: jest.fn(),
        getResolvedSettings: jest.fn(),
        onEvent: jest.fn(),
        emitEvent: jest.fn(),
        registerCustomCapability: jest.fn(),
        getCustomCapability: jest.fn(),
        hasCustomCapability: jest.fn(),
        listCustomCapabilities: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginLifecycleManagerService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByState: jest.fn().mockReturnValue([]),
                        getReady: jest.fn().mockReturnValue([]),
                        getEnabled: jest.fn().mockReturnValue([]),
                        getAll: jest.fn().mockReturnValue([]),
                        updateState: jest.fn().mockReturnValue(true),
                        unregister: jest.fn().mockReturnValue(true),
                    },
                },
                {
                    provide: PluginRepository,
                    useValue: {
                        updateState: jest.fn().mockResolvedValue({}),
                    },
                },
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                    },
                },
                {
                    provide: CustomCapabilityRegistryService,
                    useValue: {
                        unregisterByProvider: jest.fn().mockReturnValue([]),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginLifecycleManagerService>(PluginLifecycleManagerService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        pluginRepository = module.get<PluginRepository>(PluginRepository);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
        customCapabilityRegistry = module.get(CustomCapabilityRegistryService);

        // Set up mock context factory
        service.setContextFactory({
            createContext: jest.fn().mockReturnValue(mockContext),
        });
    });

    describe('isValidTransition', () => {
        it('should allow valid transitions', () => {
            expect(service.isValidTransition('loaded', 'unloading')).toBe(true);
            expect(service.isValidTransition('unloaded', 'loading')).toBe(true);
            expect(service.isValidTransition('loading', 'loaded')).toBe(true);
            expect(service.isValidTransition('loading', 'error')).toBe(true);
            expect(service.isValidTransition('error', 'loading')).toBe(true);
        });

        it('should reject invalid transitions', () => {
            expect(service.isValidTransition('unloaded', 'loaded')).toBe(false);
            expect(service.isValidTransition('loaded', 'loading')).toBe(false);
            expect(service.isValidTransition('loading', 'unloading')).toBe(false);
        });
    });

    describe('getValidTransitions', () => {
        it('should return valid target states', () => {
            expect(service.getValidTransitions('loaded')).toContain('unloading');
            expect(service.getValidTransitions('unloaded')).toContain('loading');
            expect(service.getValidTransitions('error')).toContain('loading');
            expect(service.getValidTransitions('error')).toContain('unloading');
        });
    });

    describe('callOnLoad', () => {
        it('should call onLoad for a loading plugin', async () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'loading',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.callOnLoad('test-plugin');

            expect(result.success).toBe(true);
            expect(result.newState).toBe('loaded');
            expect(plugin.onLoad).toHaveBeenCalled();
            expect(eventEmitter.emit).toHaveBeenCalledWith(PluginEvents.LOADED, expect.any(Object));
        });

        it('should fail if plugin not found', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = await service.callOnLoad('non-existent');

            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should handle onLoad error', async () => {
            const plugin = createMockPlugin();
            (plugin.onLoad as jest.Mock).mockRejectedValue(new Error('Load failed'));

            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'loading',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.callOnLoad('test-plugin');

            expect(result.success).toBe(false);
            expect(result.newState).toBe('error');
            expect(result.error).toContain('Load failed');
        });
    });

    describe('unload', () => {
        it('should unload a loaded plugin', async () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.unload('test-plugin');

            expect(result.success).toBe(true);
            expect(result.newState).toBe('unloaded');
            expect(plugin.onUnload).toHaveBeenCalled();
            expect(customCapabilityRegistry.unregisterByProvider).toHaveBeenCalledWith(
                'test-plugin',
            );
            expect(registry.unregister).toHaveBeenCalledWith('test-plugin');
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.UNLOADED,
                expect.any(Object),
            );
        });

        it('should fail for invalid state transition', async () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'unloaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.unload('test-plugin');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Cannot unload');
        });

        it('should fail if plugin not found', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = await service.unload('non-existent');

            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });
    });

    describe('shutdownAll', () => {
        it('should unload all non-unloaded plugins', async () => {
            const plugin1 = createMockPlugin();
            const plugin2 = { ...createMockPlugin(), id: 'plugin-2' } as unknown as IPlugin;

            const registered1: RegisteredPlugin = {
                plugin: plugin1,
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            const registered2: RegisteredPlugin = {
                plugin: plugin2,
                manifest: { ...createMockManifest(), id: 'plugin-2' },
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'getAll').mockReturnValue([registered1, registered2]);
            jest.spyOn(registry, 'get')
                .mockReturnValueOnce(registered1)
                .mockReturnValueOnce(registered2);

            await service.shutdownAll();

            expect(plugin1.onUnload).toHaveBeenCalled();
            expect(plugin2.onUnload).toHaveBeenCalled();
        });
    });

    describe('getState', () => {
        it('should return plugin state', () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            expect(service.getState('test-plugin')).toBe('loaded');
        });

        it('should return undefined for non-existent plugin', () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);
            expect(service.getState('non-existent')).toBeUndefined();
        });
    });

    describe('isInState', () => {
        it('should check if plugin is in specific state', () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            expect(service.isInState('test-plugin', 'loaded')).toBe(true);
            expect(service.isInState('test-plugin', 'unloaded')).toBe(false);
        });
    });
});

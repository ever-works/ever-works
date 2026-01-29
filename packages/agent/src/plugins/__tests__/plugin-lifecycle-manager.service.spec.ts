import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginLifecycleManagerService } from '../services/plugin-lifecycle-manager.service';
import { PluginRegistryService, RegisteredPlugin } from '../services/plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';
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

    const createMockPlugin = (): IPlugin =>
        ({
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['test'],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn().mockResolvedValue(undefined),
            onEnable: jest.fn().mockResolvedValue(undefined),
            onDisable: jest.fn().mockResolvedValue(undefined),
            onUnload: jest.fn().mockResolvedValue(undefined),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
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
            ],
        }).compile();

        service = module.get<PluginLifecycleManagerService>(PluginLifecycleManagerService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        pluginRepository = module.get<PluginRepository>(PluginRepository);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);

        // Set up mock context factory
        service.setContextFactory({
            createContext: jest.fn().mockReturnValue(mockContext),
        });
    });

    describe('isValidTransition', () => {
        it('should allow valid transitions', () => {
            expect(service.isValidTransition('loaded', 'enabling')).toBe(true);
            expect(service.isValidTransition('enabled', 'disabling')).toBe(true);
            expect(service.isValidTransition('disabled', 'enabling')).toBe(true);
            expect(service.isValidTransition('disabled', 'unloading')).toBe(true);
        });

        it('should reject invalid transitions', () => {
            expect(service.isValidTransition('unloaded', 'enabled')).toBe(false);
            expect(service.isValidTransition('enabled', 'loaded')).toBe(false);
            expect(service.isValidTransition('loading', 'enabled')).toBe(false);
        });
    });

    describe('getValidTransitions', () => {
        it('should return valid target states', () => {
            expect(service.getValidTransitions('loaded')).toContain('enabling');
            expect(service.getValidTransitions('loaded')).toContain('unloading');
            expect(service.getValidTransitions('enabled')).toContain('disabling');
        });
    });

    describe('enable', () => {
        it('should enable a loaded plugin', async () => {
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

            const result = await service.enable('test-plugin');

            expect(result.success).toBe(true);
            expect(result.newState).toBe('enabled');
            expect(plugin.onEnable).toHaveBeenCalled();
            expect(registry.updateState).toHaveBeenCalledWith('test-plugin', 'enabled');
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.ENABLED,
                expect.any(Object),
            );
        });

        it('should enable a disabled plugin', async () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'disabled',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.enable('test-plugin');

            expect(result.success).toBe(true);
            expect(result.previousState).toBe('disabled');
        });

        it('should fail if plugin not found', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = await service.enable('non-existent');

            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
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

            const result = await service.enable('test-plugin');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Cannot enable');
        });

        it('should handle plugin onEnable error', async () => {
            const plugin = createMockPlugin();
            (plugin.onEnable as jest.Mock).mockRejectedValue(new Error('Enable failed'));

            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.enable('test-plugin');

            expect(result.success).toBe(false);
            expect(result.newState).toBe('error');
            expect(result.error).toContain('Enable failed');
            expect(eventEmitter.emit).toHaveBeenCalledWith(PluginEvents.ERROR, expect.any(Object));
        });
    });

    describe('disable', () => {
        it('should disable an enabled plugin', async () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'enabled',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.disable('test-plugin');

            expect(result.success).toBe(true);
            expect(result.newState).toBe('disabled');
            expect(plugin.onDisable).toHaveBeenCalled();
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.DISABLED,
                expect.any(Object),
            );
        });

        it('should fail for invalid state transition', async () => {
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

            const result = await service.disable('test-plugin');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Cannot disable');
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
            expect(registry.unregister).toHaveBeenCalledWith('test-plugin');
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.UNLOADED,
                expect.any(Object),
            );
        });

        it('should unload a disabled plugin', async () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'disabled',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            const result = await service.unload('test-plugin');

            expect(result.success).toBe(true);
        });
    });

    describe('enableAll', () => {
        it('should enable all loaded and disabled plugins', async () => {
            const plugin1 = createMockPlugin();
            const plugin2: IPlugin = {
                ...createMockPlugin(),
                id: 'plugin-2',
                name: 'Plugin 2',
            } as unknown as IPlugin;

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
                state: 'disabled',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'getByState')
                .mockReturnValueOnce([registered1])
                .mockReturnValueOnce([registered2]);

            jest.spyOn(registry, 'get')
                .mockReturnValueOnce(registered1)
                .mockReturnValueOnce(registered2);

            const results = await service.enableAll();

            expect(results).toHaveLength(2);
        });
    });

    describe('getState', () => {
        it('should return plugin state', () => {
            const plugin = createMockPlugin();
            const registered: RegisteredPlugin = {
                plugin,
                manifest: createMockManifest(),
                state: 'enabled',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            expect(service.getState('test-plugin')).toBe('enabled');
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
                state: 'enabled',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(registry, 'get').mockReturnValue(registered);

            expect(service.isInState('test-plugin', 'enabled')).toBe(true);
            expect(service.isInState('test-plugin', 'disabled')).toBe(false);
        });
    });
});

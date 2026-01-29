import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { PluginContextFactoryService } from '../services/plugin-context-factory.service';
import { PluginRegistryService, RegisteredPlugin } from '../services/plugin-registry.service';
import { PluginSettingsService } from '../services/plugin-settings.service';
import { CustomCapabilityRegistryService } from '../services/custom-capability-registry.service';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { IPlugin, PluginManifest, CustomCapabilityDefinition } from '@ever-works/plugin';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => {});

describe('PluginContextFactoryService', () => {
    let service: PluginContextFactoryService;
    let registry: PluginRegistryService;
    let settingsService: PluginSettingsService;
    let customCapabilityRegistry: CustomCapabilityRegistryService;
    let eventEmitter: EventEmitter2;
    let cacheManager: any;

    const createMockPlugin = (): IPlugin =>
        ({
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['test'],
            settingsSchema: { type: 'object', properties: {} },
            configurationMode: 'hybrid',
            onLoad: jest.fn().mockResolvedValue(undefined),
            onEnable: jest.fn().mockResolvedValue(undefined),
            onDisable: jest.fn().mockResolvedValue(undefined),
            onUnload: jest.fn().mockResolvedValue(undefined),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        }) as unknown as IPlugin;

    const createRegisteredPlugin = (): RegisteredPlugin => ({
        plugin: createMockPlugin(),
        manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            description: 'Test',
            category: 'utility',
            capabilities: ['test'],
        } as PluginManifest,
        state: 'loaded',
        builtIn: false,
        registeredAt: Date.now(),
        stateHistory: [],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginContextFactoryService,
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: {
                        platformVersion: '1.0.0',
                        environment: 'test',
                        features: ['feature-a', 'feature-b'],
                        baseUrl: 'http://localhost:3000',
                        apiBaseUrl: 'http://localhost:3100',
                        tempDir: '/tmp/test',
                        dataDir: '/data/test',
                    },
                },
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn().mockReturnValue(createRegisteredPlugin()),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest.fn().mockResolvedValue({ enabled: true }),
                        getResolvedSettings: jest.fn().mockResolvedValue({
                            enabled: { key: 'enabled', value: true, source: 'default' },
                        }),
                    },
                },
                {
                    provide: CustomCapabilityRegistryService,
                    useValue: {
                        register: jest.fn(),
                        getImplementation: jest.fn(),
                        has: jest.fn().mockReturnValue(false),
                        list: jest.fn().mockReturnValue([]),
                    },
                },
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                        on: jest.fn(),
                        off: jest.fn(),
                    },
                },
                {
                    provide: CACHE_MANAGER,
                    useValue: {
                        get: jest.fn().mockResolvedValue(undefined),
                        set: jest.fn().mockResolvedValue(undefined),
                        del: jest.fn().mockResolvedValue(undefined),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginContextFactoryService>(PluginContextFactoryService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        settingsService = module.get<PluginSettingsService>(PluginSettingsService);
        customCapabilityRegistry = module.get<CustomCapabilityRegistryService>(
            CustomCapabilityRegistryService,
        );
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
        cacheManager = module.get(CACHE_MANAGER);
    });

    describe('createContext', () => {
        it('should create a context for a registered plugin', () => {
            const context = service.createContext('test-plugin');

            expect(context).toBeDefined();
            expect(context.pluginId).toBe('test-plugin');
        });

        it('should throw error for non-existent plugin', () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            expect(() => service.createContext('non-existent')).toThrow(
                'Plugin "non-existent" not found',
            );
        });

        it('should include scope options', () => {
            const context = service.createContext('test-plugin', {
                userId: 'user-1',
                directoryId: 'dir-1',
            });

            expect(context).toBeDefined();
            expect(context.pluginId).toBe('test-plugin');
        });
    });

    describe('createScopedContext', () => {
        it('should create a scoped context', () => {
            const context = service.createScopedContext('test-plugin', 'user-1', 'dir-1');

            expect(context).toBeDefined();
            expect(context.pluginId).toBe('test-plugin');
        });

        it('should work with optional parameters', () => {
            const context = service.createScopedContext('test-plugin');

            expect(context).toBeDefined();
            expect(context.pluginId).toBe('test-plugin');
        });
    });

    describe('PluginLogger', () => {
        it('should provide log method', () => {
            const context = service.createContext('test-plugin');

            expect(context.logger).toBeDefined();
            expect(typeof context.logger.log).toBe('function');
        });

        it('should provide error method', () => {
            const context = service.createContext('test-plugin');

            expect(typeof context.logger.error).toBe('function');
        });

        it('should provide warn method', () => {
            const context = service.createContext('test-plugin');

            expect(typeof context.logger.warn).toBe('function');
        });

        it('should provide debug method', () => {
            const context = service.createContext('test-plugin');

            expect(typeof context.logger.debug).toBe('function');
        });

        it('should provide verbose method', () => {
            const context = service.createContext('test-plugin');

            expect(typeof context.logger.verbose).toBe('function');
        });

        it('should not throw when calling log methods', () => {
            const context = service.createContext('test-plugin');

            expect(() => context.logger.log('test message')).not.toThrow();
            expect(() => context.logger.error('test error')).not.toThrow();
            expect(() => context.logger.warn('test warning')).not.toThrow();
            expect(() => context.logger.debug('test debug')).not.toThrow();
            expect(() => context.logger.verbose('test verbose')).not.toThrow();
        });
    });

    describe('PluginCache', () => {
        it('should provide get method', async () => {
            const context = service.createContext('test-plugin');

            const result = await context.cache.get('key');

            expect(cacheManager.get).toHaveBeenCalledWith('plugin:test-plugin:key');
            expect(result).toBeUndefined();
        });

        it('should provide set method', async () => {
            const context = service.createContext('test-plugin');

            await context.cache.set('key', 'value', 1000);

            expect(cacheManager.set).toHaveBeenCalledWith('plugin:test-plugin:key', 'value', 1000);
        });

        it('should provide delete method', async () => {
            const context = service.createContext('test-plugin');

            const result = await context.cache.delete('key');

            expect(cacheManager.del).toHaveBeenCalledWith('plugin:test-plugin:key');
            expect(result).toBe(true);
        });

        it('should provide has method', async () => {
            const context = service.createContext('test-plugin');

            cacheManager.get.mockResolvedValueOnce(undefined);
            const result1 = await context.cache.has('missing-key');
            expect(result1).toBe(false);

            cacheManager.get.mockResolvedValueOnce('value');
            const result2 = await context.cache.has('existing-key');
            expect(result2).toBe(true);
        });

        it('should provide clear method', async () => {
            const context = service.createContext('test-plugin');

            // Clear doesn't throw, just logs a warning
            await expect(context.cache.clear()).resolves.toBeUndefined();
        });

        it('should prefix cache keys with plugin ID', async () => {
            const context = service.createContext('test-plugin');

            await context.cache.set('mykey', 'myvalue');

            expect(cacheManager.set).toHaveBeenCalledWith(
                'plugin:test-plugin:mykey',
                'myvalue',
                undefined,
            );
        });
    });

    describe('PluginHttpClient', () => {
        beforeEach(() => {
            // Mock global fetch
            global.fetch = jest.fn().mockResolvedValue({
                json: jest.fn().mockResolvedValue({ data: 'test' }),
                status: 200,
                statusText: 'OK',
                headers: new Map([['content-type', 'application/json']]),
            });
        });

        afterEach(() => {
            (global.fetch as jest.Mock).mockRestore();
        });

        it('should provide get method', async () => {
            const context = service.createContext('test-plugin');

            const result = await context.http.get('https://api.example.com/data');

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.example.com/data',
                expect.objectContaining({
                    method: 'GET',
                }),
            );
            expect(result.data).toEqual({ data: 'test' });
        });

        it('should provide post method', async () => {
            const context = service.createContext('test-plugin');

            await context.http.post('https://api.example.com/data', { key: 'value' });

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.example.com/data',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ key: 'value' }),
                }),
            );
        });

        it('should provide put method', async () => {
            const context = service.createContext('test-plugin');

            await context.http.put('https://api.example.com/data', { key: 'value' });

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.example.com/data',
                expect.objectContaining({
                    method: 'PUT',
                }),
            );
        });

        it('should provide patch method', async () => {
            const context = service.createContext('test-plugin');

            await context.http.patch('https://api.example.com/data', { key: 'value' });

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.example.com/data',
                expect.objectContaining({
                    method: 'PATCH',
                }),
            );
        });

        it('should provide delete method', async () => {
            const context = service.createContext('test-plugin');

            await context.http.delete('https://api.example.com/data');

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.example.com/data',
                expect.objectContaining({
                    method: 'DELETE',
                }),
            );
        });

        it('should include custom headers', async () => {
            const context = service.createContext('test-plugin');

            await context.http.get('https://api.example.com/data', {
                headers: { Authorization: 'Bearer token' },
            });

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.example.com/data',
                expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: 'Bearer token' }),
                }),
            );
        });

        it('should return response with status info', async () => {
            const context = service.createContext('test-plugin');

            const result = await context.http.get('https://api.example.com/data');

            expect(result.status).toBe(200);
            expect(result.statusText).toBe('OK');
        });
    });

    describe('PluginEnvironment', () => {
        it('should provide platform info', () => {
            const context = service.createContext('test-plugin');

            expect(context.env.platform).toBe('ever-works');
            expect(context.env.platformVersion).toBe('1.0.0');
        });

        it('should provide node version', () => {
            const context = service.createContext('test-plugin');

            expect(context.env.nodeVersion).toBe(process.version);
        });

        it('should provide environment flags', () => {
            const context = service.createContext('test-plugin');

            expect(context.env.isProduction).toBe(false);
            expect(context.env.isDevelopment).toBe(false);
            expect(context.env.isTest).toBe(true);
        });

        it('should provide URLs', () => {
            const context = service.createContext('test-plugin');

            expect(context.env.baseUrl).toBe('http://localhost:3000');
            expect(context.env.apiBaseUrl).toBe('http://localhost:3100');
        });

        it('should provide directories', () => {
            const context = service.createContext('test-plugin');

            expect(context.env.tempDir).toBe('/tmp/test');
            expect(context.env.dataDir).toBe('/data/test');
        });

        it('should provide features set', () => {
            const context = service.createContext('test-plugin');

            expect(context.env.features).toBeDefined();
            expect(context.env.features.has('feature-a')).toBe(true);
            expect(context.env.features.has('feature-b')).toBe(true);
        });
    });

    describe('EnvironmentVariables', () => {
        beforeEach(() => {
            process.env.TEST_VAR = 'test-value';
        });

        afterEach(() => {
            delete process.env.TEST_VAR;
        });

        it('should provide get method', () => {
            const context = service.createContext('test-plugin');

            expect(context.envVars.get('TEST_VAR')).toBe('test-value');
            expect(context.envVars.get('NON_EXISTENT')).toBeUndefined();
        });

        it('should provide getOrDefault method', () => {
            const context = service.createContext('test-plugin');

            expect(context.envVars.getOrDefault('TEST_VAR', 'default')).toBe('test-value');
            expect(context.envVars.getOrDefault('NON_EXISTENT', 'default')).toBe('default');
        });

        it('should provide has method', () => {
            const context = service.createContext('test-plugin');

            expect(context.envVars.has('TEST_VAR')).toBe(true);
            expect(context.envVars.has('NON_EXISTENT')).toBe(false);
        });

        it('should provide getRequired method', () => {
            const context = service.createContext('test-plugin');

            expect(context.envVars.getRequired('TEST_VAR')).toBe('test-value');
            expect(() => context.envVars.getRequired('NON_EXISTENT')).toThrow(
                'Required environment variable "NON_EXISTENT" is not set',
            );
        });
    });

    describe('getSettings', () => {
        it('should call settings service', async () => {
            const context = service.createContext('test-plugin');

            const result = await context.getSettings();

            expect(settingsService.getSettings).toHaveBeenCalledWith('test-plugin', {
                scope: undefined,
            });
            expect(result).toEqual({ enabled: true });
        });

        it('should pass scope options', async () => {
            const context = service.createContext('test-plugin', { userId: 'user-1' });

            await context.getSettings('user', 'user-1');

            expect(settingsService.getSettings).toHaveBeenCalledWith(
                'test-plugin',
                expect.objectContaining({ scope: 'user', userId: 'user-1' }),
            );
        });
    });

    describe('getResolvedSettings', () => {
        it('should call settings service', async () => {
            const context = service.createContext('test-plugin');

            const result = await context.getResolvedSettings();

            expect(settingsService.getResolvedSettings).toHaveBeenCalled();
            expect(result.enabled).toBeDefined();
        });
    });

    describe('event handling', () => {
        it('should subscribe to events via onEvent', () => {
            const context = service.createContext('test-plugin');
            const handler = jest.fn();

            const subscription = context.onEvent('plugin:loaded' as any, handler);

            expect(eventEmitter.on).toHaveBeenCalledWith('plugin:loaded', expect.any(Function));
            expect(subscription.unsubscribe).toBeDefined();
        });

        it('should unsubscribe when calling unsubscribe', () => {
            const context = service.createContext('test-plugin');
            const handler = jest.fn();

            const subscription = context.onEvent('plugin:loaded' as any, handler);
            subscription.unsubscribe();

            expect(eventEmitter.off).toHaveBeenCalled();
        });

        it('should emit events via emitEvent', () => {
            const context = service.createContext('test-plugin');

            context.emitEvent('plugin:loaded' as any, { pluginId: 'test' });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                'plugin:loaded',
                expect.objectContaining({
                    pluginId: 'test',
                    timestamp: expect.any(Number),
                    correlationId: expect.any(String),
                }),
            );
        });
    });

    describe('custom capability integration', () => {
        it('should register custom capability', () => {
            const context = service.createContext('test-plugin');
            const capability: CustomCapabilityDefinition = {
                name: 'custom-cap',
                version: '1.0.0',
                description: 'Test capability',
                methods: ['doSomething'],
            };
            const implementation = { doSomething: () => {} };

            context.registerCustomCapability(capability, implementation);

            expect(customCapabilityRegistry.register).toHaveBeenCalledWith(
                capability,
                implementation,
                'test-plugin',
            );
        });

        it('should get custom capability', () => {
            const context = service.createContext('test-plugin');
            const mockImpl = { doSomething: () => {} };
            jest.spyOn(customCapabilityRegistry, 'getImplementation').mockReturnValue(mockImpl);

            const result = context.getCustomCapability('custom-cap');

            expect(customCapabilityRegistry.getImplementation).toHaveBeenCalledWith('custom-cap');
            expect(result).toBe(mockImpl);
        });

        it('should check if custom capability exists', () => {
            const context = service.createContext('test-plugin');
            jest.spyOn(customCapabilityRegistry, 'has').mockReturnValue(true);

            const result = context.hasCustomCapability('custom-cap');

            expect(customCapabilityRegistry.has).toHaveBeenCalledWith('custom-cap');
            expect(result).toBe(true);
        });

        it('should list custom capabilities', () => {
            const context = service.createContext('test-plugin');
            const capabilities: CustomCapabilityDefinition[] = [
                { name: 'cap-1', version: '1.0.0', description: '', methods: [] },
            ];
            jest.spyOn(customCapabilityRegistry, 'list').mockReturnValue(capabilities);

            const result = context.listCustomCapabilities();

            expect(customCapabilityRegistry.list).toHaveBeenCalled();
            expect(result).toEqual(capabilities);
        });
    });

    describe('PluginServices', () => {
        it('should provide services object', () => {
            const context = service.createContext('test-plugin');

            expect(context.services).toBeDefined();
            expect(context.services.directory).toBeUndefined();
            expect(context.services.user).toBeUndefined();
        });
    });

    describe('default options', () => {
        it('should use default platform version when not specified', async () => {
            const module = await Test.createTestingModule({
                providers: [
                    PluginContextFactoryService,
                    {
                        provide: PLUGINS_MODULE_OPTIONS,
                        useValue: {},
                    },
                    {
                        provide: PluginRegistryService,
                        useValue: { get: jest.fn().mockReturnValue(createRegisteredPlugin()) },
                    },
                    {
                        provide: PluginSettingsService,
                        useValue: {
                            getSettings: jest.fn(),
                            getResolvedSettings: jest.fn(),
                        },
                    },
                    {
                        provide: CustomCapabilityRegistryService,
                        useValue: {
                            register: jest.fn(),
                            getImplementation: jest.fn(),
                            has: jest.fn(),
                            list: jest.fn(),
                        },
                    },
                    {
                        provide: EventEmitter2,
                        useValue: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
                    },
                    {
                        provide: CACHE_MANAGER,
                        useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
                    },
                ],
            }).compile();

            const testService = module.get<PluginContextFactoryService>(
                PluginContextFactoryService,
            );
            const context = testService.createContext('test-plugin');

            // Should use default development environment
            expect(context.env.isDevelopment).toBe(true);
        });
    });
});

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PluginLoaderService } from '../services/plugin-loader.service';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { PluginManifestValidatorService } from '../services/plugin-manifest-validator.service';
import { PluginVersionCheckerService } from '../services/plugin-version-checker.service';
import { PluginClassValidatorService } from '../services/plugin-class-validator.service';
import { PluginRepository } from '../repositories/plugin.repository';
import { PLUGINS_MODULE_OPTIONS } from '../plugins.constants';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('PluginLoaderService', () => {
    let service: PluginLoaderService;
    let registry: PluginRegistryService;
    let manifestValidator: PluginManifestValidatorService;
    let versionChecker: PluginVersionCheckerService;
    let classValidator: PluginClassValidatorService;
    let pluginRepository: PluginRepository;

    const createMockPlugin = (id: string = 'test-plugin'): IPlugin =>
        ({
            id,
            name: `Plugin ${id}`,
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

    const createMockManifest = (id: string = 'test-plugin'): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: 'utility',
        capabilities: ['test'],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginLoaderService,
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: {
                        pluginPaths: ['./plugins'],
                        builtInPlugins: [],
                        platformVersion: '1.0.0',
                    },
                },
                {
                    provide: PluginRegistryService,
                    useValue: {
                        has: jest.fn().mockReturnValue(false),
                        get: jest.fn(),
                        register: jest.fn().mockReturnValue({}),
                        unregister: jest.fn().mockReturnValue(true),
                        getVersionsMap: jest.fn().mockReturnValue(new Map()),
                    },
                },
                {
                    provide: PluginManifestValidatorService,
                    useValue: {
                        validate: jest.fn().mockReturnValue({ valid: true }),
                        extractManifest: jest.fn(),
                        validateAndExtract: jest.fn().mockReturnValue({
                            manifest: null,
                            validation: { valid: false },
                        }),
                    },
                },
                {
                    provide: PluginVersionCheckerService,
                    useValue: {
                        check: jest.fn().mockReturnValue({ valid: true }),
                    },
                },
                {
                    provide: PluginClassValidatorService,
                    useValue: {
                        validate: jest.fn().mockReturnValue({ valid: true }),
                        isPlugin: jest.fn().mockReturnValue(true),
                        isPluginClass: jest.fn().mockReturnValue(false),
                    },
                },
                {
                    provide: PluginRepository,
                    useValue: {
                        upsert: jest.fn().mockResolvedValue({}),
                        updateState: jest.fn().mockResolvedValue({}),
                        findByPluginId: jest.fn().mockResolvedValue(null),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginLoaderService>(PluginLoaderService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        manifestValidator = module.get<PluginManifestValidatorService>(
            PluginManifestValidatorService,
        );
        versionChecker = module.get<PluginVersionCheckerService>(PluginVersionCheckerService);
        classValidator = module.get<PluginClassValidatorService>(PluginClassValidatorService);
        pluginRepository = module.get<PluginRepository>(PluginRepository);
    });

    describe('load', () => {
        it('should load a discovered plugin successfully', async () => {
            const plugin = createMockPlugin();
            const manifest = createMockManifest();

            jest.spyOn(classValidator, 'isPluginClass').mockReturnValue(false);
            jest.spyOn(classValidator, 'isPlugin').mockReturnValue(true);

            const discovered = {
                path: '/path/to/plugin',
                packageJson: { name: 'test-plugin' },
                manifest,
                builtIn: false,
            };

            // Mock dynamic import - we need to mock the internal module loading
            const originalLoad = (service as any).loadPluginModule;
            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            const result = await service.load(discovered);

            expect(result.success).toBe(true);
            expect(result.pluginId).toBe('test-plugin');
            expect(registry.register).toHaveBeenCalledWith(plugin, manifest, {
                builtIn: false,
                installPath: '/path/to/plugin',
                state: 'loaded',
            });
            expect(pluginRepository.upsert).toHaveBeenCalled();

            // Restore
            (service as any).loadPluginModule = originalLoad;
        });

        it('should fail if plugin is already registered', async () => {
            const manifest = createMockManifest();
            jest.spyOn(registry, 'has').mockReturnValue(true);

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(false);
            expect(result.error).toContain('already loaded');
        });

        it('should fail if version check fails', async () => {
            const manifest = createMockManifest();
            jest.spyOn(versionChecker, 'check').mockReturnValue({
                valid: false,
                compatible: false,
                dependenciesSatisfied: false,
                errors: [{ path: 'version', message: 'Incompatible version' }],
            });

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Version check failed');
        });

        it('should fail if plugin module loading fails', async () => {
            const manifest = createMockManifest();
            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            // Mock loadPluginModule to return null (failure)
            (service as any).loadPluginModule = jest.fn().mockResolvedValue(null);

            const result = await service.load(discovered);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to load plugin module');
        });

        it('should fail if class validation fails', async () => {
            const plugin = createMockPlugin();
            const manifest = createMockManifest();

            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);
            jest.spyOn(classValidator, 'validate').mockReturnValue({
                valid: false,
                errors: [{ path: 'onLoad', message: 'Missing method' }],
            });

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Plugin validation failed');
        });

        it('should include warnings from version checker and class validator', async () => {
            const plugin = createMockPlugin();
            const manifest = createMockManifest();

            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);
            jest.spyOn(versionChecker, 'check').mockReturnValue({
                valid: true,
                compatible: true,
                dependenciesSatisfied: true,
                warnings: [{ path: 'version', message: 'Minor version mismatch' }],
            });
            jest.spyOn(classValidator, 'validate').mockReturnValue({
                valid: true,
                warnings: [{ path: 'getManifest', message: 'Optional method missing' }],
            });

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(true);
            expect(result.warnings).toHaveLength(2);
        });
    });

    describe('loadBuiltIn', () => {
        it('should load a built-in plugin instance', async () => {
            const plugin = createMockPlugin('built-in-plugin');

            const pluginModule = {
                plugin,
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            expect(result.pluginId).toBe('built-in-plugin');
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({ id: 'built-in-plugin' }),
                expect.objectContaining({ builtIn: true, state: 'loaded' }),
            );
        });

        it('should load a built-in plugin class', async () => {
            const plugin = createMockPlugin('built-in-class-plugin');

            class TestPlugin {
                id = 'built-in-class-plugin';
                name = 'Built-in Class Plugin';
                version = '1.0.0';
                category = 'utility';
                capabilities = ['test'];
                settingsSchema = { type: 'object', properties: {} };
                onLoad = jest.fn();
                onEnable = jest.fn();
                onDisable = jest.fn();
                onUnload = jest.fn();
                validateSettings = jest.fn().mockResolvedValue({ valid: true });
            }

            const pluginModule = {
                plugin: TestPlugin as any,
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            expect(registry.register).toHaveBeenCalled();
        });

        it('should use provided manifest when available', async () => {
            const plugin = createMockPlugin('custom-manifest-plugin');
            const manifest = createMockManifest('custom-manifest-plugin');

            jest.spyOn(manifestValidator, 'validate').mockReturnValue({ valid: true });

            const pluginModule = {
                plugin,
                manifest: manifest as unknown as Record<string, unknown>,
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            expect(manifestValidator.validate).toHaveBeenCalledWith(manifest);
        });

        it('should fail if manifest validation fails', async () => {
            const plugin = createMockPlugin('invalid-manifest-plugin');

            jest.spyOn(manifestValidator, 'validate').mockReturnValue({
                valid: false,
                errors: [{ path: 'id', message: 'Invalid ID' }],
            });

            const pluginModule = {
                plugin,
                manifest: { id: 'x' },
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid manifest');
        });

        it('should fail if plugin is already registered', async () => {
            const plugin = createMockPlugin('duplicate-plugin');
            jest.spyOn(registry, 'has').mockReturnValue(true);

            const pluginModule = { plugin };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(false);
            expect(result.error).toContain('already loaded');
        });

        it('should fail if class validation fails', async () => {
            const plugin = createMockPlugin('invalid-class-plugin');
            jest.spyOn(classValidator, 'validate').mockReturnValue({
                valid: false,
                errors: [{ path: 'onLoad', message: 'Missing method' }],
            });

            const pluginModule = { plugin };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Plugin validation failed');
        });

        it('should use getManifest from plugin when available', async () => {
            const manifest = createMockManifest('manifest-getter-plugin');
            const plugin = {
                ...createMockPlugin('manifest-getter-plugin'),
                getManifest: jest.fn().mockReturnValue(manifest),
            };

            const pluginModule = { plugin };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            expect(plugin.getManifest).toHaveBeenCalled();
        });
    });

    describe('loadAllBuiltIn', () => {
        it('should load all built-in plugins from options', async () => {
            const plugin1 = createMockPlugin('builtin-1');
            const plugin2 = createMockPlugin('builtin-2');

            // Create a new service with built-in plugins
            const module = await Test.createTestingModule({
                providers: [
                    PluginLoaderService,
                    {
                        provide: PLUGINS_MODULE_OPTIONS,
                        useValue: {
                            pluginPaths: [],
                            builtInPlugins: [{ plugin: plugin1 }, { plugin: plugin2 }],
                            platformVersion: '1.0.0',
                        },
                    },
                    {
                        provide: PluginRegistryService,
                        useValue: {
                            has: jest.fn().mockReturnValue(false),
                            register: jest.fn().mockReturnValue({}),
                            getVersionsMap: jest.fn().mockReturnValue(new Map()),
                        },
                    },
                    {
                        provide: PluginManifestValidatorService,
                        useValue: {
                            validate: jest.fn().mockReturnValue({ valid: true }),
                        },
                    },
                    {
                        provide: PluginVersionCheckerService,
                        useValue: { check: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginClassValidatorService,
                        useValue: { validate: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginRepository,
                        useValue: { upsert: jest.fn().mockResolvedValue({}) },
                    },
                ],
            }).compile();

            const testService = module.get<PluginLoaderService>(PluginLoaderService);
            const results = await testService.loadAllBuiltIn();

            expect(results).toHaveLength(2);
            expect(results[0].success).toBe(true);
            expect(results[1].success).toBe(true);
        });
    });

    describe('unload', () => {
        it('should unload a registered plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue({
                plugin: createMockPlugin(),
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            });

            const result = await service.unload('test-plugin');

            expect(result).toBe(true);
            expect(registry.unregister).toHaveBeenCalledWith('test-plugin');
            expect(pluginRepository.updateState).toHaveBeenCalledWith('test-plugin', 'unloaded');
        });

        it('should return false for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = await service.unload('non-existent');

            expect(result).toBe(false);
        });
    });

    describe('reload', () => {
        it('should reload an external plugin from disk', async () => {
            const plugin = createMockPlugin();
            const manifest = createMockManifest();

            jest.spyOn(registry, 'get').mockReturnValue({
                plugin,
                manifest,
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
                installPath: '/path/to/plugin',
            });

            // Mock tryLoadPluginManifest
            (service as any).tryLoadPluginManifest = jest.fn().mockResolvedValue({
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            });

            // Mock load
            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            const result = await service.reload('test-plugin');

            expect(result.success).toBe(true);
            expect(registry.unregister).toHaveBeenCalledWith('test-plugin');
        });

        it('should fail for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = await service.reload('non-existent');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Plugin not found');
        });

        it('should fail for built-in plugin without install path', async () => {
            jest.spyOn(registry, 'get').mockReturnValue({
                plugin: createMockPlugin(),
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: true,
                registeredAt: Date.now(),
                stateHistory: [],
            });

            const result = await service.reload('test-plugin');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Built-in plugins cannot be reloaded');
        });

        it('should fail if manifest is no longer valid', async () => {
            jest.spyOn(registry, 'get').mockReturnValue({
                plugin: createMockPlugin(),
                manifest: createMockManifest(),
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
                installPath: '/path/to/plugin',
            });

            (service as any).tryLoadPluginManifest = jest.fn().mockResolvedValue(null);

            const result = await service.reload('test-plugin');

            expect(result.success).toBe(false);
            expect(result.error).toContain('manifest no longer valid');
        });
    });

    describe('discover', () => {
        it('should return empty array when no plugin paths exist', async () => {
            // Mock pathExists to return false
            (service as any).pathExists = jest.fn().mockResolvedValue(false);

            const discovered = await service.discover();

            expect(discovered).toEqual([]);
        });
    });

    describe('topological sort', () => {
        it('should load plugins in dependency order', async () => {
            const pluginA = createMockPlugin('plugin-a');
            const pluginB = createMockPlugin('plugin-b');
            const pluginC = createMockPlugin('plugin-c');
            const mockRegister = jest.fn().mockReturnValue({});

            // C depends on B, B depends on A
            const module = await Test.createTestingModule({
                providers: [
                    PluginLoaderService,
                    {
                        provide: PLUGINS_MODULE_OPTIONS,
                        useValue: {
                            pluginPaths: [],
                            builtInPlugins: [
                                {
                                    plugin: pluginC,
                                    manifest: {
                                        ...createMockManifest('plugin-c'),
                                        dependencies: { 'plugin-b': '^1.0.0' },
                                    },
                                },
                                {
                                    plugin: pluginB,
                                    manifest: {
                                        ...createMockManifest('plugin-b'),
                                        dependencies: { 'plugin-a': '^1.0.0' },
                                    },
                                },
                                { plugin: pluginA, manifest: createMockManifest('plugin-a') },
                            ],
                            platformVersion: '1.0.0',
                        },
                    },
                    {
                        provide: PluginRegistryService,
                        useValue: {
                            has: jest.fn().mockReturnValue(false),
                            register: mockRegister,
                            getVersionsMap: jest.fn().mockReturnValue(new Map()),
                        },
                    },
                    {
                        provide: PluginManifestValidatorService,
                        useValue: {
                            validate: jest.fn().mockReturnValue({ valid: true }),
                        },
                    },
                    {
                        provide: PluginVersionCheckerService,
                        useValue: { check: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginClassValidatorService,
                        useValue: { validate: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginRepository,
                        useValue: { upsert: jest.fn().mockResolvedValue({}) },
                    },
                ],
            }).compile();

            const testService = module.get<PluginLoaderService>(PluginLoaderService);
            const results = await testService.discoverAndLoadAll();

            expect(results.loaded).toBe(3);
            // Verify they loaded in correct order: A, then B, then C
            const registerCalls = mockRegister.mock.calls;
            expect(registerCalls[0][0].id).toBe('plugin-a');
            expect(registerCalls[1][0].id).toBe('plugin-b');
            expect(registerCalls[2][0].id).toBe('plugin-c');
        });

        it('should detect circular dependencies', async () => {
            const pluginA = createMockPlugin('plugin-a');
            const pluginB = createMockPlugin('plugin-b');

            // A depends on B, B depends on A (circular)
            const module = await Test.createTestingModule({
                providers: [
                    PluginLoaderService,
                    {
                        provide: PLUGINS_MODULE_OPTIONS,
                        useValue: {
                            pluginPaths: [],
                            builtInPlugins: [
                                {
                                    plugin: pluginA,
                                    manifest: {
                                        ...createMockManifest('plugin-a'),
                                        dependencies: { 'plugin-b': '^1.0.0' },
                                    },
                                },
                                {
                                    plugin: pluginB,
                                    manifest: {
                                        ...createMockManifest('plugin-b'),
                                        dependencies: { 'plugin-a': '^1.0.0' },
                                    },
                                },
                            ],
                            platformVersion: '1.0.0',
                        },
                    },
                    {
                        provide: PluginRegistryService,
                        useValue: {
                            has: jest.fn().mockReturnValue(false),
                            register: jest.fn().mockReturnValue({}),
                            getVersionsMap: jest.fn().mockReturnValue(new Map()),
                        },
                    },
                    {
                        provide: PluginManifestValidatorService,
                        useValue: {
                            validate: jest.fn().mockReturnValue({ valid: true }),
                        },
                    },
                    {
                        provide: PluginVersionCheckerService,
                        useValue: { check: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginClassValidatorService,
                        useValue: { validate: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginRepository,
                        useValue: { upsert: jest.fn().mockResolvedValue({}) },
                    },
                ],
            }).compile();

            const testService = module.get<PluginLoaderService>(PluginLoaderService);

            await expect(testService.discoverAndLoadAll()).rejects.toThrow(
                'Circular dependency detected',
            );
        });

        it('should fail when dependency is missing', async () => {
            const pluginA = createMockPlugin('plugin-a');

            // A depends on non-existent plugin
            const module = await Test.createTestingModule({
                providers: [
                    PluginLoaderService,
                    {
                        provide: PLUGINS_MODULE_OPTIONS,
                        useValue: {
                            pluginPaths: [],
                            builtInPlugins: [
                                {
                                    plugin: pluginA,
                                    manifest: {
                                        ...createMockManifest('plugin-a'),
                                        dependencies: { 'missing-plugin': '^1.0.0' },
                                    },
                                },
                            ],
                            platformVersion: '1.0.0',
                        },
                    },
                    {
                        provide: PluginRegistryService,
                        useValue: {
                            has: jest.fn().mockReturnValue(false),
                            register: jest.fn().mockReturnValue({}),
                            getVersionsMap: jest.fn().mockReturnValue(new Map()),
                        },
                    },
                    {
                        provide: PluginManifestValidatorService,
                        useValue: {
                            validate: jest.fn().mockReturnValue({ valid: true }),
                        },
                    },
                    {
                        provide: PluginVersionCheckerService,
                        useValue: { check: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginClassValidatorService,
                        useValue: { validate: jest.fn().mockReturnValue({ valid: true }) },
                    },
                    {
                        provide: PluginRepository,
                        useValue: { upsert: jest.fn().mockResolvedValue({}) },
                    },
                ],
            }).compile();

            const testService = module.get<PluginLoaderService>(PluginLoaderService);

            await expect(testService.discoverAndLoadAll()).rejects.toThrow(
                'depends on unknown plugin',
            );
        });
    });
});

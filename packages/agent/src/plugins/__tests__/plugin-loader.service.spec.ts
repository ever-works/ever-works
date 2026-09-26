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
            onUnload: jest.fn().mockResolvedValue(undefined),
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
                        registerLazy: jest.fn().mockReturnValue({}),
                        updateRegisteredManifest: jest.fn().mockReturnValue(true),
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

        it('should merge runtime manifest from getManifest() into discovered manifest', async () => {
            const manifest = createMockManifest();
            const plugin = {
                ...createMockPlugin(),
                getManifest: jest.fn().mockReturnValue({
                    ...manifest,
                    readme: '## Plugin Readme',
                    icon: { type: 'svg', value: '<svg/>' },
                }),
            };

            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(true);
            // The manifest passed to register should have package.json fields (spread last)
            // but also include readme from getManifest() (runtime manifest fills gaps)
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({
                    id: 'test-plugin',
                    readme: '## Plugin Readme',
                }),
                expect.any(Object),
            );
        });

        it('should give package.json manifest priority over runtime manifest', async () => {
            const manifest = { ...createMockManifest(), description: 'From package.json' };
            const plugin = {
                ...createMockPlugin(),
                getManifest: jest.fn().mockReturnValue({
                    ...createMockManifest(),
                    description: 'From getManifest',
                    readme: '## Readme',
                }),
            };

            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(true);
            // package.json manifest spread last, so its description wins
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({
                    description: 'From package.json',
                    readme: '## Readme',
                }),
                expect.any(Object),
            );
        });

        it('should not override runtime manifest fields with undefined from package.json manifest', async () => {
            // Simulate a manifest with explicit undefined keys (e.g. from extractManifest spread)
            const manifest = {
                ...createMockManifest(),
                homepage: undefined,
                license: undefined,
            } as unknown as PluginManifest;

            const plugin = {
                ...createMockPlugin(),
                getManifest: jest.fn().mockReturnValue({
                    ...createMockManifest(),
                    homepage: 'https://github.com/example/repo',
                    license: 'AGPL-3.0',
                    icon: { type: 'svg', value: '<svg/>' },
                }),
            };

            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            const discovered = {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            };

            const result = await service.load(discovered);

            expect(result.success).toBe(true);
            // Runtime homepage and license should survive (undefined filtered out)
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({
                    homepage: 'https://github.com/example/repo',
                    license: 'AGPL-3.0',
                    icon: { type: 'svg', value: '<svg/>' },
                }),
                expect.any(Object),
            );
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
                onUnload = jest.fn();
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

        it('should merge runtime manifest with declared manifest', async () => {
            const declaredManifest = createMockManifest('merge-test-plugin');
            const plugin = {
                ...createMockPlugin('merge-test-plugin'),
                getManifest: jest.fn().mockReturnValue({
                    ...declaredManifest,
                    homepage: 'https://example.com/from-runtime',
                    readme: '## Runtime Readme',
                    icon: { type: 'svg', value: '<svg/>' },
                }),
            };

            jest.spyOn(manifestValidator, 'validate').mockReturnValue({ valid: true });

            const pluginModule = {
                plugin,
                manifest: declaredManifest as unknown as Record<string, unknown>,
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            // Declared manifest fields should override runtime
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({
                    id: 'merge-test-plugin',
                    description: 'Test plugin',
                    // Runtime-only fields should be preserved
                    readme: '## Runtime Readme',
                    icon: { type: 'svg', value: '<svg/>' },
                    homepage: 'https://example.com/from-runtime',
                }),
                expect.any(Object),
            );
        });

        it('should give declared manifest priority over runtime manifest for shared fields', async () => {
            const declaredManifest = {
                ...createMockManifest('priority-test-plugin'),
                description: 'From declared manifest',
            };
            const plugin = {
                ...createMockPlugin('priority-test-plugin'),
                getManifest: jest.fn().mockReturnValue({
                    ...createMockManifest('priority-test-plugin'),
                    description: 'From runtime manifest',
                    readme: '## Readme',
                }),
            };

            jest.spyOn(manifestValidator, 'validate').mockReturnValue({ valid: true });

            const pluginModule = {
                plugin,
                manifest: declaredManifest as unknown as Record<string, unknown>,
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({
                    description: 'From declared manifest',
                    readme: '## Readme',
                }),
                expect.any(Object),
            );
        });

        it('should not override runtime manifest fields with undefined from declared manifest', async () => {
            // Declared manifest has no homepage (undefined)
            const declaredManifest = createMockManifest('undefined-filter-plugin');
            const plugin = {
                ...createMockPlugin('undefined-filter-plugin'),
                getManifest: jest.fn().mockReturnValue({
                    ...declaredManifest,
                    homepage: 'https://example.com/should-survive',
                }),
            };

            jest.spyOn(manifestValidator, 'validate').mockReturnValue({ valid: true });

            // Simulate a manifest with an explicit undefined key
            const manifestWithUndefined = {
                ...declaredManifest,
                homepage: undefined,
            } as unknown as Record<string, unknown>;

            const pluginModule = {
                plugin,
                manifest: manifestWithUndefined,
            };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            // Runtime homepage should survive because undefined is filtered out
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({
                    homepage: 'https://example.com/should-survive',
                }),
                expect.any(Object),
            );
        });

        it('should not call getManifest when no declared manifest is provided', async () => {
            const manifest = createMockManifest('no-declared-plugin');
            const plugin = {
                ...createMockPlugin('no-declared-plugin'),
                getManifest: jest.fn().mockReturnValue(manifest),
            };

            const pluginModule = { plugin };

            const result = await service.loadBuiltIn(pluginModule);

            expect(result.success).toBe(true);
            // getManifest is used as the sole source when no declared manifest
            expect(plugin.getManifest).toHaveBeenCalled();
            expect(registry.register).toHaveBeenCalledWith(
                plugin,
                expect.objectContaining({ id: 'no-declared-plugin' }),
                expect.any(Object),
            );
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

    /**
     * EW-693 — `operations` and `executionProfile` decide what the execution
     * router may call and where it runs. A lazily registered plugin is routed
     * BEFORE it loads, from its package.json manifest; a declaration only
     * `getManifest()` supplied was merged in at first use, so the same
     * operation routed in-process on a cold replica and to the job runtime on
     * a warm one. Routing declarations now come from the static manifest only.
     */
    describe('routing declarations come from the static manifest only', () => {
        const runtimeDeclares = {
            operations: [{ name: 'runLong', executionProfile: 'long-running' }],
            executionProfile: 'long-running',
        };

        it('load(): drops operations and executionProfile that only getManifest() supplies', async () => {
            const manifest = createMockManifest();
            const plugin = {
                ...createMockPlugin(),
                getManifest: jest.fn().mockReturnValue({
                    ...manifest,
                    readme: '## Readme',
                    ...runtimeDeclares,
                }),
            };
            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            const result = await service.load({
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            });

            expect(result.success).toBe(true);
            const registered = (registry.register as jest.Mock).mock.calls[0][1];
            expect(registered.readme).toBe('## Readme'); // other runtime fields still merge
            expect(registered.operations).toBeUndefined();
            expect(registered.executionProfile).toBeUndefined();
        });

        it('load(): keeps the declarations package.json makes', async () => {
            const manifest = {
                ...createMockManifest(),
                operations: [{ name: 'fromPackageJson' }],
                executionProfile: 'sync',
            } as PluginManifest;
            const plugin = {
                ...createMockPlugin(),
                getManifest: jest
                    .fn()
                    .mockReturnValue({ ...createMockManifest(), ...runtimeDeclares }),
            };
            (service as any).loadPluginModule = jest.fn().mockResolvedValue(plugin);

            await service.load({
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            });

            const registered = (registry.register as jest.Mock).mock.calls[0][1];
            expect(registered.operations).toEqual([{ name: 'fromPackageJson' }]);
            expect(registered.executionProfile).toBe('sync');
        });

        it('first materialisation of a lazy plugin: does not fold runtime-only declarations into the registered manifest', async () => {
            const manifest = createMockManifest();
            const real = {
                ...createMockPlugin(),
                getManifest: jest.fn().mockReturnValue({
                    ...manifest,
                    readme: '## Readme',
                    ...runtimeDeclares,
                }),
            };

            await (service as any).enrichManifestAfterMaterialize('test-plugin', real, {
                path: '/path/to/plugin',
                packageJson: {},
                manifest,
                builtIn: false,
            });

            expect(registry.updateRegisteredManifest).toHaveBeenCalledTimes(1);
            const merged = (registry.updateRegisteredManifest as jest.Mock).mock.calls[0][1];
            expect(merged.readme).toBe('## Readme');
            expect(merged.operations).toBeUndefined();
            expect(merged.executionProfile).toBeUndefined();
        });
    });

    /**
     * A package WITH an `everworks.plugin` block whose manifest fails validation
     * (e.g. a reserved name in `operations`) used to vanish from discovery
     * without a log line — in the API and in the worker.
     */
    describe('an invalid plugin manifest is reported, not dropped silently', () => {
        it('warns with the validation errors for a package that declares a plugin', async () => {
            const warn = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);
            warn.mockClear();
            (manifestValidator.validateAndExtract as jest.Mock).mockReturnValue({
                manifest: null,
                validation: {
                    valid: false,
                    errors: [{ path: 'operations[0].name', message: 'must be a method name' }],
                },
            });
            const readFile = jest
                .spyOn(require('fs/promises'), 'readFile')
                .mockResolvedValue(
                    JSON.stringify({ name: 'x', everworks: { plugin: { id: 'bad-plugin' } } }),
                );

            await expect(
                (service as any).tryLoadPluginManifest('/plugins/bad-plugin'),
            ).resolves.toBeNull();

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('operations[0].name: must be a method name'),
            );
            readFile.mockRestore();
            warn.mockRestore();
        });

        it('stays quiet for a package that is not a plugin at all', async () => {
            const warn = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);
            warn.mockClear();
            const readFile = jest
                .spyOn(require('fs/promises'), 'readFile')
                .mockResolvedValue(JSON.stringify({ name: 'just-a-library' }));

            await expect(
                (service as any).tryLoadPluginManifest('/plugins/lib'),
            ).resolves.toBeNull();

            expect(warn).not.toHaveBeenCalled();
            readFile.mockRestore();
            warn.mockRestore();
        });
    });
});

/**
 * EW-693 T27 — registering a plugin the installer placed at runtime.
 *
 * The installer puts a package at `<installDir>/.versions/<pkg>/<version>` and
 * links it at `<installDir>/node_modules/<pkg>`. Nothing registered it: the
 * loader's `discover()` keeps only entries one level deep whose Dirent is a
 * DIRECTORY, and the link is not one. `registerFromPath` registers the
 * directory the installer answers, and only when it IS the plugin asked for.
 *
 * Real registry, real manifest validator, real fixture on disk — only the
 * repository is a double.
 */
describe('PluginLoaderService — registering a runtime-installed plugin (T27)', () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fsSync = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const nodePath = require('path') as typeof import('path');
    const { EventEmitter2 } = require('@nestjs/event-emitter');
    /* eslint-enable @typescript-eslint/no-var-requires */

    let storeDir: string;
    let loader: PluginLoaderService;
    let registry: PluginRegistryService;
    let repository: {
        upsert: jest.Mock;
        updateState: jest.Mock;
        findByPluginId: jest.Mock;
        mergeLazyRegistration: jest.Mock;
    };

    /** A plugin package as the installer leaves it in the versioned store. */
    function writePluginPackage(dir: string, id: string, extra: Record<string, unknown> = {}) {
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(
            nodePath.join(dir, 'package.json'),
            JSON.stringify({
                name: `@ever-works/${id}-plugin`,
                version: '1.2.0',
                main: './index.js',
                everworks: {
                    plugin: {
                        id,
                        name: `Plugin ${id}`,
                        version: '1.2.0',
                        category: 'utility',
                        capabilities: [],
                        description: 'A runtime-installed fixture.',
                        builtIn: true,
                        ...extra,
                    },
                },
            }),
        );
        fsSync.writeFileSync(
            nodePath.join(dir, 'index.js'),
            `module.exports = class P {\n` +
                `  constructor() { this.id = ${JSON.stringify(id)}; }\n` +
                `  async onLoad() {}\n` +
                `  async onUnload() {}\n` +
                `};\n`,
        );
    }

    const versioned = (id: string) =>
        nodePath.join(storeDir, '.versions', `@ever-works__${id}-plugin`, '1.2.0');

    async function makeLoader(pluginPaths: string[] = []) {
        repository = {
            upsert: jest.fn().mockResolvedValue({}),
            updateState: jest.fn().mockResolvedValue({}),
            findByPluginId: jest.fn().mockResolvedValue(null),
            mergeLazyRegistration: jest.fn().mockResolvedValue({}),
        };
        const moduleRef = await Test.createTestingModule({
            providers: [
                PluginLoaderService,
                PluginRegistryService,
                PluginManifestValidatorService,
                PluginVersionCheckerService,
                PluginClassValidatorService,
                { provide: EventEmitter2, useValue: new EventEmitter2() },
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: { pluginPaths, builtInPlugins: [], platformVersion: '1.0.0' },
                },
                { provide: PluginRepository, useValue: repository },
            ],
        }).compile();
        loader = moduleRef.get(PluginLoaderService);
        registry = moduleRef.get(PluginRegistryService);
    }

    beforeEach(() => {
        storeDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'ew693-loader-store-'));
    });

    afterEach(() => {
        fsSync.rmSync(storeDir, { recursive: true, force: true });
    });

    it('registers the directory the installer answers — lazily, as not built-in, at that path', async () => {
        writePluginPackage(versioned('notion-extractor'), 'notion-extractor');
        await makeLoader();

        const result = await loader.registerFromPath(versioned('notion-extractor'), {
            expectedId: 'notion-extractor',
        });

        expect(result).toMatchObject({ success: true, pluginId: 'notion-extractor' });
        const entry = registry.get('notion-extractor');
        expect(entry).toBeDefined();
        // A lazy proxy: nothing was imported yet.
        expect(typeof (entry!.plugin as { __materialize?: unknown }).__materialize).toBe(
            'function',
        );
        // Runtime-installed, so never treated as a built-in of this image —
        // even though its manifest says `builtIn: true`.
        expect(entry!.builtIn).toBe(false);
        expect(entry!.installPath).toBe(versioned('notion-extractor'));
        // Pin changed (a worker read per registration): was `repository.upsert`.
        // A lazy registration's row is written by ONE repository call, which the
        // Trigger worker answers in memory (see the lazy-registration block below).
        expect(repository.mergeLazyRegistration).toHaveBeenCalledWith(
            expect.objectContaining({
                pluginId: 'notion-extractor',
                builtIn: false,
                installPath: versioned('notion-extractor'),
            }),
            expect.objectContaining({ id: 'notion-extractor' }),
        );
    });

    it('registers NOTHING when the package declares a different plugin id', async () => {
        writePluginPackage(versioned('notion-extractor'), 'someone-else');
        await makeLoader();

        const result = await loader.registerFromPath(versioned('notion-extractor'), {
            expectedId: 'notion-extractor',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('someone-else');
        expect(registry.get('notion-extractor')).toBeUndefined();
        expect(registry.get('someone-else')).toBeUndefined();
        expect(repository.upsert).not.toHaveBeenCalled();
        expect(repository.mergeLazyRegistration).not.toHaveBeenCalled();
    });

    it('registers nothing for a directory that is not a plugin package', async () => {
        fsSync.mkdirSync(versioned('notion-extractor'), { recursive: true });
        fsSync.writeFileSync(
            nodePath.join(versioned('notion-extractor'), 'package.json'),
            JSON.stringify({ name: 'just-a-library', version: '1.0.0' }),
        );
        await makeLoader();

        const result = await loader.registerFromPath(versioned('notion-extractor'), {
            expectedId: 'notion-extractor',
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not a plugin package/);
        expect(registry.get('notion-extractor')).toBeUndefined();
    });

    it('keeps an existing registration — the plugin already in this process wins', async () => {
        writePluginPackage(versioned('notion-extractor'), 'notion-extractor');
        await makeLoader();
        await loader.registerFromPath(versioned('notion-extractor'), {
            expectedId: 'notion-extractor',
        });
        const first = registry.get('notion-extractor');

        const again = await loader.registerFromPath(versioned('notion-extractor'), {
            expectedId: 'notion-extractor',
        });

        expect(again).toMatchObject({ success: true, pluginId: 'notion-extractor' });
        expect(again.warnings?.[0]).toContain('already registered');
        expect(registry.get('notion-extractor')).toBe(first);
        // Pin changed (a worker read per registration): was `repository.upsert`
        // once — the row write is `mergeLazyRegistration` now; still once.
        expect(repository.mergeLazyRegistration).toHaveBeenCalledTimes(1);
    });

    /**
     * CHARACTERIZATION (passes before and after T27) — why `registerFromPath`
     * is needed at all: discovery over the store the installer builds finds
     * nothing, neither at its root nor under its `node_modules` scope.
     */
    it('discover() over an installer-shaped store finds no plugin', async () => {
        writePluginPackage(versioned('notion-extractor'), 'notion-extractor');
        const scope = nodePath.join(storeDir, 'node_modules', '@ever-works');
        fsSync.mkdirSync(scope, { recursive: true });
        fsSync.symlinkSync(
            versioned('notion-extractor'),
            nodePath.join(scope, 'notion-extractor-plugin'),
            'junction',
        );
        await makeLoader([storeDir, scope]);

        await expect(loader.discover()).resolves.toEqual([]);
    });
});

/**
 * The DB row a lazy registration writes (`registerLazy`), and the one its first
 * materialisation writes (the runtime manifest fold). Real loader, real
 * registry, real lazy proxy, a plugin package on disk — only the repository is
 * a double.
 */
describe('PluginLoaderService — the plugin row a lazy registration and first load write', () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fsSync = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const nodePath = require('path') as typeof import('path');
    const { EventEmitter2 } = require('@nestjs/event-emitter');
    /* eslint-enable @typescript-eslint/no-var-requires */

    let dir: string;
    let repository: {
        upsert: jest.Mock;
        updateState: jest.Mock;
        findByPluginId: jest.Mock;
        updateByPluginId: jest.Mock;
        mergeLazyRegistration: jest.Mock;
    };
    let loader: PluginLoaderService;
    let registry: PluginRegistryService;

    function writePlugin() {
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(
            nodePath.join(dir, 'package.json'),
            JSON.stringify({
                name: '@ever-works/lean-row-plugin',
                version: '2.0.0',
                main: './index.js',
                everworks: {
                    plugin: {
                        id: 'lean-row',
                        name: 'Lean Row',
                        version: '2.0.0',
                        category: 'utility',
                        capabilities: ['test'],
                        description: 'package.json description',
                    },
                },
            }),
        );
        fsSync.writeFileSync(
            nodePath.join(dir, 'index.js'),
            `module.exports = class P {\n` +
                `  constructor() { this.id = 'lean-row'; }\n` +
                `  getManifest() { return { id: 'lean-row', name: 'Lean Row', version: '2.0.0',` +
                ` category: 'utility', capabilities: ['test'], description: 'runtime',` +
                ` icon: 'runtime-icon', homepage: 'https://runtime.example' }; }\n` +
                `  async onLoad() {}\n` +
                `  async onUnload() {}\n` +
                `};\n`,
        );
    }

    async function makeLoader() {
        repository = {
            upsert: jest.fn().mockResolvedValue({}),
            updateState: jest.fn().mockResolvedValue({}),
            findByPluginId: jest.fn().mockResolvedValue(null),
            updateByPluginId: jest.fn().mockResolvedValue({}),
            mergeLazyRegistration: jest.fn().mockResolvedValue({}),
        };
        const moduleRef = await Test.createTestingModule({
            providers: [
                PluginLoaderService,
                PluginRegistryService,
                PluginManifestValidatorService,
                PluginVersionCheckerService,
                PluginClassValidatorService,
                { provide: EventEmitter2, useValue: new EventEmitter2() },
                {
                    provide: PLUGINS_MODULE_OPTIONS,
                    useValue: { pluginPaths: [], builtInPlugins: [], platformVersion: '1.0.0' },
                },
                { provide: PluginRepository, useValue: repository },
            ],
        }).compile();
        loader = moduleRef.get(PluginLoaderService);
        registry = moduleRef.get(PluginRegistryService);
    }

    beforeEach(() => {
        dir = nodePath.join(
            fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'lean-row-')),
            'lean-row-plugin',
        );
    });

    afterEach(() => {
        fsSync.rmSync(nodePath.dirname(dir), { recursive: true, force: true });
    });

    /**
     * Every process boot registers each disk plugin lazily and writes its row.
     * With builtIns lazy that is every API boot and every Trigger run.
     *
     * Pins changed (a worker read per registration): the three cases here
     * pinned the merge as the LOADER's — `findByPluginId`, then
     * `updateByPluginId` or `upsert` — and that read was the defect. In a
     * Trigger worker `PluginRepository` is a remote proxy whose reads go to the
     * API, so every plugin a run registered cost one round trip
     * (`trigger-run-plugin-operation.module.spec.ts` › "still dialled nothing
     * after running operations"). The read-merge-write is now ONE repository
     * method, `mergeLazyRegistration`, which the worker's `LocalPluginStore`
     * answers in memory; its rules (same version keeps the row's keys with
     * package.json on top, another version or no row writes package.json as it
     * is) moved with it, to `plugin.repository.lazy-registration.spec.ts` (real
     * sqlite) and the tasks package's `local-plugin-store.spec.ts`.
     */
    it('writes its row through one mergeLazyRegistration call, reading nothing', async () => {
        writePlugin();
        await makeLoader();

        await expect(
            loader.registerFromPath(dir, { expectedId: 'lean-row' }),
        ).resolves.toMatchObject({ success: true });

        expect(repository.mergeLazyRegistration).toHaveBeenCalledTimes(1);
        const [row, manifest] = repository.mergeLazyRegistration.mock.calls[0];
        expect(row).toEqual({
            pluginId: 'lean-row',
            name: 'Lean Row',
            version: '2.0.0',
            description: 'package.json description',
            category: 'utility',
            capabilities: ['test'],
            builtIn: false,
            installPath: dir,
            state: 'loaded',
        });
        // The package.json manifest, not the class's (nothing is imported yet).
        expect(manifest).toMatchObject({
            id: 'lean-row',
            version: '2.0.0',
            description: 'package.json description',
        });
        expect((manifest as Record<string, unknown>).icon).toBeUndefined();
        expect(repository.findByPluginId).not.toHaveBeenCalled();
        expect(repository.updateByPluginId).not.toHaveBeenCalled();
        expect(repository.upsert).not.toHaveBeenCalled();
    });

    /**
     * The first materialisation runs `onLoad` right after the import, before
     * the manifest DB upsert (which used to come first), and a failing
     * `onLoad` is not overwritten back to `loaded` by that upsert.
     */
    it('runs onLoad before the runtime manifest upsert, which then keeps an onLoad failure', async () => {
        writePlugin();
        await makeLoader();
        const order: string[] = [];
        // What PluginBootstrapService wires: callOnLoad, here failing.
        loader.setOnFirstMaterialize(async (pluginId) => {
            order.push('onLoad');
            registry.updateState(pluginId, 'error', new Error('onLoad refused'));
        });
        await loader.registerFromPath(dir, { expectedId: 'lean-row' });
        repository.upsert.mockClear();
        repository.upsert.mockImplementation(async () => {
            order.push('upsert');
            return {};
        });

        await (
            registry.get('lean-row')!.plugin as unknown as { __materialize(): Promise<unknown> }
        ).__materialize();

        expect(order).toEqual(['onLoad', 'upsert']);
        const row = repository.upsert.mock.calls[0][0] as Record<string, unknown>;
        expect((row.manifest as Record<string, unknown>).icon).toBe('runtime-icon');
        expect(row.state).toBeUndefined();
    });
});

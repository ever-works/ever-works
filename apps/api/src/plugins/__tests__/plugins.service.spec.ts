import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginsService } from '../plugins.service';
import {
    PluginEntity,
    UserPluginEntity,
    DirectoryPluginEntity,
    PluginRegistryService,
} from '@packages/agent/plugins';
import type { RegisteredPlugin } from '@packages/agent/plugins';
import type { IPlugin, PluginManifest, JsonSchema } from '@ever-works/plugin';
import { SettingsSchemaValidatorService } from '../services';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('PluginsService', () => {
    let service: PluginsService;
    let pluginRepository: Repository<PluginEntity>;
    let userPluginRepository: Repository<UserPluginEntity>;
    let directoryPluginRepository: Repository<DirectoryPluginEntity>;
    let pluginRegistryService: PluginRegistryService;

    const createSettingsSchema = (): JsonSchema =>
        ({
            type: 'object',
            properties: {
                clientId: {
                    type: 'string',
                    'x-envVar': 'TEST_CLIENT_ID',
                    'x-writeOnly': true,
                },
                clientSecret: {
                    type: 'string',
                    'x-envVar': 'TEST_CLIENT_SECRET',
                    'x-secret': true,
                    'x-masked': true,
                    'x-writeOnly': true,
                },
                apiBaseUrl: {
                    type: 'string',
                    'x-envVar': 'TEST_API_URL',
                    default: 'https://api.example.com',
                },
                normalSetting: {
                    type: 'string',
                    default: 'default-value',
                },
                maskedField: {
                    type: 'string',
                    'x-masked': true,
                },
                writeOnlyField: {
                    type: 'string',
                    'x-writeOnly': true,
                },
            },
        }) as unknown as JsonSchema;

    const createMockPlugin = (settingsSchema?: JsonSchema): IPlugin =>
        ({
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['test'],
            settingsSchema: settingsSchema || createSettingsSchema(),
            configurationMode: 'hybrid',
            onLoad: jest.fn().mockResolvedValue(undefined),
            onEnable: jest.fn().mockResolvedValue(undefined),
            onDisable: jest.fn().mockResolvedValue(undefined),
            onUnload: jest.fn().mockResolvedValue(undefined),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        }) as unknown as IPlugin;

    const createRegisteredPlugin = (plugin?: IPlugin): RegisteredPlugin => ({
        plugin: plugin || createMockPlugin(),
        manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            description: 'Test plugin description',
            category: 'utility',
            capabilities: ['test'],
            visibility: 'public',
        } as PluginManifest,
        state: 'loaded',
        builtIn: false,
        registeredAt: Date.now(),
        stateHistory: [],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginsService,
                {
                    provide: getRepositoryToken(PluginEntity),
                    useValue: {
                        findOne: jest.fn().mockResolvedValue(null),
                        find: jest.fn().mockResolvedValue([]),
                        save: jest.fn().mockImplementation((entity) => entity),
                        create: jest.fn().mockImplementation((data) => data),
                    },
                },
                {
                    provide: getRepositoryToken(UserPluginEntity),
                    useValue: {
                        findOne: jest.fn().mockResolvedValue(null),
                        find: jest.fn().mockResolvedValue([]),
                        save: jest.fn().mockImplementation((entity) => entity),
                        create: jest.fn().mockImplementation((data) => data),
                    },
                },
                {
                    provide: getRepositoryToken(DirectoryPluginEntity),
                    useValue: {
                        findOne: jest.fn().mockResolvedValue(null),
                        find: jest.fn().mockResolvedValue([]),
                        save: jest.fn().mockImplementation((entity) => entity),
                        create: jest.fn().mockImplementation((data) => data),
                        createQueryBuilder: jest.fn().mockReturnValue({
                            update: jest.fn().mockReturnThis(),
                            set: jest.fn().mockReturnThis(),
                            where: jest.fn().mockReturnThis(),
                            andWhere: jest.fn().mockReturnThis(),
                            execute: jest.fn().mockResolvedValue({}),
                        }),
                    },
                },
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn().mockReturnValue(createRegisteredPlugin()),
                        getAll: jest.fn().mockReturnValue([createRegisteredPlugin()]),
                        getAvailableCategories: jest.fn().mockReturnValue(['utility']),
                        getAvailableCapabilities: jest.fn().mockReturnValue(['test']),
                    },
                },
                {
                    provide: SettingsSchemaValidatorService,
                    useValue: {
                        validate: jest.fn().mockReturnValue({ valid: true, errors: [] }),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginsService>(PluginsService);
        pluginRepository = module.get<Repository<PluginEntity>>(getRepositoryToken(PluginEntity));
        userPluginRepository = module.get<Repository<UserPluginEntity>>(
            getRepositoryToken(UserPluginEntity),
        );
        directoryPluginRepository = module.get<Repository<DirectoryPluginEntity>>(
            getRepositoryToken(DirectoryPluginEntity),
        );
        pluginRegistryService = module.get<PluginRegistryService>(PluginRegistryService);
    });

    describe('maskSecretSettings security', () => {
        describe('x-envVar filtering', () => {
            it('should exclude x-envVar fields from user plugin response', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        clientId: 'should-not-appear',
                        apiBaseUrl: 'also-should-not-appear',
                        normalSetting: 'should-appear',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                // x-envVar fields should NOT be in the response
                expect(result.settings).toBeDefined();
                expect(result.settings!.clientId).toBeUndefined();
                expect(result.settings!.apiBaseUrl).toBeUndefined();
                // Normal fields should appear
                expect(result.settings!.normalSetting).toBe('should-appear');
            });

            it('should exclude x-envVar fields from directory plugin response', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([registered]);

                jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                    {
                        id: '1',
                        userId: 'user-1',
                        pluginId: 'test-plugin',
                        enabled: true,
                        settings: { normalSetting: 'user-value' },
                        secretSettings: {},
                        metadata: {},
                    } as any,
                ]);

                jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([
                    {
                        id: '1',
                        directoryId: 'dir-1',
                        pluginId: 'test-plugin',
                        enabled: true,
                        settings: {
                            clientId: 'should-not-appear',
                            normalSetting: 'should-appear',
                        },
                        secretSettings: {},
                        metadata: {},
                    } as any,
                ]);

                const result = await service.listDirectoryPlugins('dir-1', 'user-1');

                const plugin = result.plugins.find((p) => p.pluginId === 'test-plugin');
                expect(plugin).toBeDefined();
                // x-envVar fields should NOT be in directory settings
                expect(plugin!.directorySettings).toBeDefined();
                expect(plugin!.directorySettings!.clientId).toBeUndefined();
                expect(plugin!.directorySettings!.normalSetting).toBe('should-appear');
            });
        });

        describe('x-writeOnly filtering', () => {
            it('should exclude x-writeOnly fields from response', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        writeOnlyField: 'should-not-appear',
                        normalSetting: 'should-appear',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                expect(result.settings!.writeOnlyField).toBeUndefined();
                expect(result.settings!.normalSetting).toBe('should-appear');
            });
        });

        describe('x-masked handling', () => {
            it('should mask x-masked fields with asterisks', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        maskedField: 'secret-value',
                        normalSetting: 'normal-value',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                expect(result.settings!.maskedField).toBe('********');
                expect(result.settings!.normalSetting).toBe('normal-value');
            });

            it('should not mask null or undefined x-masked fields', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        maskedField: null,
                        normalSetting: 'normal-value',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                // null/undefined values should pass through as-is, not be masked
                expect(result.settings!.maskedField).toBeNull();
            });
        });

        describe('combined filtering', () => {
            it('should correctly filter x-envVar, x-writeOnly, and mask x-masked in single response', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        clientId: 'env-var-field',
                        clientSecret: 'env-var-and-masked',
                        apiBaseUrl: 'env-var-field-2',
                        normalSetting: 'normal',
                        maskedField: 'will-be-masked',
                        writeOnlyField: 'write-only',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                // x-envVar fields excluded
                expect(result.settings!.clientId).toBeUndefined();
                expect(result.settings!.clientSecret).toBeUndefined();
                expect(result.settings!.apiBaseUrl).toBeUndefined();
                // x-writeOnly excluded
                expect(result.settings!.writeOnlyField).toBeUndefined();
                // x-masked is masked
                expect(result.settings!.maskedField).toBe('********');
                // normal field passes through
                expect(result.settings!.normalSetting).toBe('normal');
            });
        });

        describe('schema without properties', () => {
            it('should return settings as-is when schema has no properties', async () => {
                const schemaWithoutProps: JsonSchema = {
                    type: 'object',
                } as JsonSchema;

                const plugin = createMockPlugin(schemaWithoutProps);
                const registered = createRegisteredPlugin(plugin);
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        anyField: 'any-value',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                expect(result.settings!.anyField).toBe('any-value');
            });
        });
    });

    describe('getPlugin', () => {
        it('should throw NotFoundException for non-existent plugin', async () => {
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(undefined);

            await expect(service.getPlugin('non-existent', 'user-1')).rejects.toThrow(
                NotFoundException,
            );
        });

        it('should return plugin with user installation status', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.pluginId).toBe('test-plugin');
            expect(result.installed).toBe(true);
            expect(result.enabled).toBe(true);
        });
    });

    describe('enablePluginForUser', () => {
        it('should throw NotFoundException for non-existent plugin', async () => {
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(undefined);

            await expect(service.enablePluginForUser('non-existent', 'user-1')).rejects.toThrow(
                NotFoundException,
            );
        });

        it('should create new user plugin when not exists', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.enablePluginForUser('test-plugin', 'user-1');

            expect(result.installed).toBe(true);
            expect(result.enabled).toBe(true);
            expect(userPluginRepository.save).toHaveBeenCalled();
        });
    });

    describe('disablePluginForUser', () => {
        it('should disable an enabled plugin', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);

            const result = await service.disablePluginForUser('test-plugin', 'user-1');

            expect(result.enabled).toBe(false);
            expect(userPluginRepository.save).toHaveBeenCalled();
        });
    });

    describe('extractSettingsSchema filtering', () => {
        it('should exclude x-envVar fields from settings schema', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.properties.clientId).toBeUndefined();
            expect(result.settingsSchema!.properties.clientSecret).toBeUndefined();
            expect(result.settingsSchema!.properties.apiBaseUrl).toBeUndefined();
        });

        it('should exclude x-writeOnly fields from settings schema', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.properties.writeOnlyField).toBeUndefined();
        });

        it('should include normal fields in settings schema', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.properties.normalSetting).toBeDefined();
            expect(result.settingsSchema!.properties.maskedField).toBeDefined();
        });

        it('should filter required array to exclude filtered fields', async () => {
            const schemaWithRequired: JsonSchema = {
                type: 'object',
                properties: {
                    envField: { type: 'string', 'x-envVar': 'TEST_VAR' },
                    normalField: { type: 'string' },
                },
                required: ['envField', 'normalField'],
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schemaWithRequired);
            const registered = createRegisteredPlugin(plugin);
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.required).toEqual(['normalField']);
        });
    });

    describe('visibility filtering', () => {
        it('should filter out user-only plugins from listDirectoryPlugins', async () => {
            const userOnlyPlugin = createRegisteredPlugin();
            userOnlyPlugin.manifest = {
                ...userOnlyPlugin.manifest,
                id: 'user-only-plugin',
                visibility: 'user-only',
            } as PluginManifest;
            userOnlyPlugin.plugin = {
                ...userOnlyPlugin.plugin,
                id: 'user-only-plugin',
            } as IPlugin;

            const directoryPlugin = createRegisteredPlugin();
            directoryPlugin.manifest = {
                ...directoryPlugin.manifest,
                id: 'directory-plugin',
                visibility: 'public',
            } as PluginManifest;
            directoryPlugin.plugin = {
                ...directoryPlugin.plugin,
                id: 'directory-plugin',
            } as IPlugin;

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                userOnlyPlugin,
                directoryPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);
            jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.listDirectoryPlugins('dir-1', 'user-1');

            expect(result.plugins.length).toBe(1);
            expect(result.plugins[0].pluginId).toBe('directory-plugin');
        });

        it('should filter out hidden plugins from listDirectoryPlugins', async () => {
            const hiddenPlugin = createRegisteredPlugin();
            hiddenPlugin.manifest = {
                ...hiddenPlugin.manifest,
                id: 'hidden-plugin',
                visibility: 'hidden',
            } as PluginManifest;
            hiddenPlugin.plugin = {
                ...hiddenPlugin.plugin,
                id: 'hidden-plugin',
            } as IPlugin;

            const publicPlugin = createRegisteredPlugin();
            publicPlugin.manifest = {
                ...publicPlugin.manifest,
                id: 'public-plugin',
                visibility: 'public',
            } as PluginManifest;
            publicPlugin.plugin = {
                ...publicPlugin.plugin,
                id: 'public-plugin',
            } as IPlugin;

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                hiddenPlugin,
                publicPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);
            jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.listDirectoryPlugins('dir-1', 'user-1');

            expect(result.plugins.length).toBe(1);
            expect(result.plugins[0].pluginId).toBe('public-plugin');
        });

        it('should include plugins with default visibility in listDirectoryPlugins', async () => {
            const defaultVisibilityPlugin = createRegisteredPlugin();
            // No visibility set - should default to 'public'
            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([defaultVisibilityPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);
            jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.listDirectoryPlugins('dir-1', 'user-1');

            expect(result.plugins.length).toBe(1);
        });
    });
});

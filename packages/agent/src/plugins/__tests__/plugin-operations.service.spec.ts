import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginOperationsService } from '../services/plugin-operations.service';
import { PluginEntity } from '../entities/plugin.entity';
import { UserPluginEntity } from '../entities/user-plugin.entity';
import { DirectoryPluginEntity } from '../entities/directory-plugin.entity';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { SettingsSchemaValidatorService } from '../services/settings-schema-validator.service';
import type { RegisteredPlugin } from '../services/plugin-registry.service';
import type { IPlugin, PluginManifest, JsonSchema } from '@ever-works/plugin';

// Mock the facades module to avoid transitive cross-package @src path resolution issues
jest.mock('../../facades', () => ({
    AiFacadeService: class AiFacadeService {},
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AiFacadeService } = require('../../facades');

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('PluginOperationsService', () => {
    let service: PluginOperationsService;
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
                },
                clientSecret: {
                    type: 'string',
                    'x-envVar': 'TEST_CLIENT_SECRET',
                    'x-secret': true,
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
                secretField: {
                    type: 'string',
                    'x-secret': true,
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
                PluginOperationsService,
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
                {
                    provide: AiFacadeService,
                    useValue: {
                        getAvailableModels: jest.fn().mockResolvedValue([]),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginOperationsService>(PluginOperationsService);
        pluginRepository = module.get<Repository<PluginEntity>>(getRepositoryToken(PluginEntity));
        userPluginRepository = module.get<Repository<UserPluginEntity>>(
            getRepositoryToken(UserPluginEntity),
        );
        directoryPluginRepository = module.get<Repository<DirectoryPluginEntity>>(
            getRepositoryToken(DirectoryPluginEntity),
        );
        pluginRegistryService = module.get<PluginRegistryService>(PluginRegistryService);
    });

    describe('secret settings in API response', () => {
        describe('x-secret fields return real values', () => {
            it('should return real secret values for x-secret fields', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        normalSetting: 'should-appear',
                    },
                    secretSettings: {
                        secretField: 'real-secret-value',
                    },
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                expect(result.settings!.secretField).toBe('real-secret-value');
                expect(result.settings!.normalSetting).toBe('should-appear');
            });

            it('should return real secret values in directory plugin response', async () => {
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
                            normalSetting: 'should-appear',
                        },
                        secretSettings: {
                            secretField: 'real-dir-secret',
                        },
                        metadata: {},
                    } as any,
                ]);

                const result = await service.listDirectoryPlugins('dir-1', 'user-1');

                const plugin = result.plugins.find((p) => p.pluginId === 'test-plugin');
                expect(plugin).toBeDefined();
                expect(plugin!.directorySettings).toBeDefined();
                expect(plugin!.directorySettings!.secretField).toBe('real-dir-secret');
                expect(plugin!.directorySettings!.normalSetting).toBe('should-appear');
            });
        });

        describe('non-secret x-envVar fields pass through', () => {
            it('should include non-secret x-envVar fields in response', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        clientId: 'my-client-id',
                        apiBaseUrl: 'https://custom.api.com',
                        normalSetting: 'should-appear',
                    },
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                expect(result.settings!.clientId).toBe('my-client-id');
                expect(result.settings!.apiBaseUrl).toBe('https://custom.api.com');
                expect(result.settings!.normalSetting).toBe('should-appear');
            });
        });

        describe('combined settings and secretSettings merge', () => {
            it('should return all fields with real values', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        clientId: 'env-var-field',
                        apiBaseUrl: 'https://custom.api.com',
                        normalSetting: 'normal',
                    },
                    secretSettings: {
                        clientSecret: 'secret-env-var',
                        secretField: 'secret-value',
                    },
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                // Secret fields return real values
                expect(result.settings!.clientSecret).toBe('secret-env-var');
                expect(result.settings!.secretField).toBe('secret-value');
                // Non-secret fields pass through
                expect(result.settings!.clientId).toBe('env-var-field');
                expect(result.settings!.apiBaseUrl).toBe('https://custom.api.com');
                expect(result.settings!.normalSetting).toBe('normal');
            });
        });

        describe('empty secret fields', () => {
            it('should return empty string for empty x-secret fields', async () => {
                const registered = createRegisteredPlugin();
                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    settings: {
                        normalSetting: 'should-appear',
                    },
                    secretSettings: {
                        secretField: '',
                    },
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.settings).toBeDefined();
                expect(result.settings!.secretField).toBe('');
                expect(result.settings!.normalSetting).toBe('should-appear');
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

    describe('listPlugins', () => {
        it('should filter by category when category param is provided', async () => {
            const aiPlugin = createRegisteredPlugin();
            aiPlugin.plugin = { ...aiPlugin.plugin, id: 'openai' } as IPlugin;
            aiPlugin.manifest = {
                ...aiPlugin.manifest,
                id: 'openai',
                category: 'ai-provider',
            } as PluginManifest;

            const gitPlugin = createRegisteredPlugin();
            gitPlugin.plugin = { ...gitPlugin.plugin, id: 'github' } as IPlugin;
            gitPlugin.manifest = {
                ...gitPlugin.manifest,
                id: 'github',
                category: 'git-provider',
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([aiPlugin, gitPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'openai',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'github',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.listPlugins('user-1', 'ai-provider');

            expect(result.plugins).toHaveLength(1);
            expect(result.plugins[0].pluginId).toBe('openai');
        });

        it('should only return enabled plugins when category is provided', async () => {
            const enabledPlugin = createRegisteredPlugin();
            enabledPlugin.plugin = { ...enabledPlugin.plugin, id: 'openai' } as IPlugin;
            enabledPlugin.manifest = {
                ...enabledPlugin.manifest,
                id: 'openai',
                category: 'ai-provider',
            } as PluginManifest;

            const disabledPlugin = createRegisteredPlugin();
            disabledPlugin.plugin = { ...disabledPlugin.plugin, id: 'anthropic' } as IPlugin;
            disabledPlugin.manifest = {
                ...disabledPlugin.manifest,
                id: 'anthropic',
                category: 'ai-provider',
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                enabledPlugin,
                disabledPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'openai',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'anthropic',
                    enabled: false,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.listPlugins('user-1', 'ai-provider');

            expect(result.plugins).toHaveLength(1);
            expect(result.plugins[0].pluginId).toBe('openai');
        });

        it('should return all visible plugins when no category is provided', async () => {
            const aiPlugin = createRegisteredPlugin();
            aiPlugin.plugin = { ...aiPlugin.plugin, id: 'openai' } as IPlugin;
            aiPlugin.manifest = {
                ...aiPlugin.manifest,
                id: 'openai',
                category: 'ai-provider',
            } as PluginManifest;

            const gitPlugin = createRegisteredPlugin();
            gitPlugin.plugin = { ...gitPlugin.plugin, id: 'github' } as IPlugin;
            gitPlugin.manifest = {
                ...gitPlugin.manifest,
                id: 'github',
                category: 'git-provider',
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([aiPlugin, gitPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.listPlugins('user-1');

            expect(result.plugins).toHaveLength(2);
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

        it('should throw BadRequestException when disabling a systemPlugin', async () => {
            const systemPlugin = createRegisteredPlugin();
            systemPlugin.manifest = {
                ...systemPlugin.manifest,
                systemPlugin: true,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(systemPlugin);

            await expect(service.disablePluginForUser('test-plugin', 'user-1')).rejects.toThrow(
                BadRequestException,
            );
        });

        it('should allow disabling an autoEnable plugin', async () => {
            const autoEnablePlugin = createRegisteredPlugin();
            autoEnablePlugin.manifest = {
                ...autoEnablePlugin.manifest,
                autoEnable: true,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnablePlugin);
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

    describe('disablePluginForDirectory', () => {
        it('should throw BadRequestException when disabling a systemPlugin at directory level', async () => {
            const systemPlugin = createRegisteredPlugin();
            systemPlugin.manifest = {
                ...systemPlugin.manifest,
                systemPlugin: true,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(systemPlugin);

            await expect(
                service.disablePluginForDirectory('dir-1', 'test-plugin', 'user-1'),
            ).rejects.toThrow(BadRequestException);
        });

        it('should allow disabling an autoEnable plugin at directory level', async () => {
            const autoEnablePlugin = createRegisteredPlugin();
            autoEnablePlugin.manifest = {
                ...autoEnablePlugin.manifest,
                autoEnable: true,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnablePlugin);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                directoryId: 'dir-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);

            const result = await service.disablePluginForDirectory(
                'dir-1',
                'test-plugin',
                'user-1',
            );

            expect(result.directoryEnabled).toBe(false);
            expect(directoryPluginRepository.save).toHaveBeenCalled();
        });

        it('should successfully disable a normal plugin for directory', async () => {
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
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                directoryId: 'dir-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);

            const result = await service.disablePluginForDirectory(
                'dir-1',
                'test-plugin',
                'user-1',
            );

            expect(result.directoryEnabled).toBe(false);
            expect(directoryPluginRepository.save).toHaveBeenCalled();
        });
    });

    describe('extractSettingsSchema filtering', () => {
        it('should include x-envVar fields in settings schema (user can override)', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            // x-envVar fields should now be included (users can override env values)
            expect(result.settingsSchema!.properties.clientId).toBeDefined();
            expect(result.settingsSchema!.properties.clientSecret).toBeDefined();
            expect(result.settingsSchema!.properties.apiBaseUrl).toBeDefined();
        });

        it('should exclude x-adminOnly fields from settings schema', async () => {
            const adminOnlySchema: JsonSchema = {
                type: 'object',
                properties: {
                    adminField: { type: 'string', 'x-adminOnly': true },
                    userField: { type: 'string' },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(adminOnlySchema);
            const registered = createRegisteredPlugin(plugin);
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.properties.adminField).toBeUndefined();
            expect(result.settingsSchema!.properties.userField).toBeDefined();
        });

        it('should include x-secret fields in settings schema', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.properties.secretField).toBeDefined();
        });

        it('should include normal fields in settings schema', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.settingsSchema).toBeDefined();
            expect(result.settingsSchema!.properties.normalSetting).toBeDefined();
        });

        it('should filter required array to exclude filtered fields', async () => {
            const schemaWithRequired: JsonSchema = {
                type: 'object',
                properties: {
                    hiddenField: { type: 'string', 'x-hidden': true },
                    normalField: { type: 'string' },
                },
                required: ['hiddenField', 'normalField'],
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

    describe('secretSettings persistence', () => {
        it('should save new secret value when user updates secret field', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: { secretField: 'old-secret' },
                metadata: {},
            } as any);

            await service.updateUserPluginSettings('test-plugin', 'user-1', undefined, {
                secretField: 'new-actual-secret',
            });

            expect(userPluginRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    secretSettings: { secretField: 'new-actual-secret' },
                }),
            );
        });

        it('should save secret settings on enablePluginForUser', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            await service.enablePluginForUser('test-plugin', 'user-1', undefined, {
                secretField: 'my-secret',
            });

            expect(userPluginRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    secretSettings: { secretField: 'my-secret' },
                }),
            );
        });

        it('should save secret settings on updateDirectoryPluginSettings', async () => {
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
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                directoryId: 'dir-1',
                pluginId: 'test-plugin',
                enabled: true,
                settings: {},
                secretSettings: { secretField: 'original-secret' },
                metadata: {},
            } as any);

            await service.updateDirectoryPluginSettings(
                'dir-1',
                'test-plugin',
                'user-1',
                undefined,
                { secretField: 'new-secret' },
            );

            expect(directoryPluginRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    secretSettings: { secretField: 'new-secret' },
                }),
            );
        });
    });

    describe('getPluginsForSettingsMenu', () => {
        const createPluginWithSettings = (
            id: string,
            category: string,
            configMode: string = 'hybrid',
            visibility: string = 'public',
            autoEnable: boolean = false,
            settingsSchema?: JsonSchema,
        ): RegisteredPlugin => {
            const defaultSchema: JsonSchema = {
                type: 'object',
                properties: {
                    apiKey: { type: 'string', 'x-scope': 'user' },
                },
                required: ['apiKey'],
            } as unknown as JsonSchema;

            const plugin = {
                id,
                name: `${id} Plugin`,
                version: '1.0.0',
                category,
                capabilities: ['test'],
                settingsSchema: settingsSchema || defaultSchema,
                configurationMode: configMode,
                onLoad: jest.fn().mockResolvedValue(undefined),
                onUnload: jest.fn().mockResolvedValue(undefined),
                validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            } as unknown as IPlugin;

            return {
                plugin,
                manifest: {
                    id,
                    name: `${id} Plugin`,
                    version: '1.0.0',
                    description: 'Test plugin',
                    category,
                    capabilities: ['test'],
                    visibility,
                    autoEnable,
                } as PluginManifest,
                state: 'loaded',
                builtIn: false,
                registeredAt: Date.now(),
                stateHistory: [],
            };
        };

        it('should return empty categories when no plugins have settings', async () => {
            const pluginWithoutSettings = createPluginWithSettings(
                'no-settings',
                'utility',
                'hybrid',
                'public',
                false,
                { type: 'object' } as JsonSchema, // No properties
            );

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([pluginWithoutSettings]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'no-settings',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(0);
        });

        it('should return only enabled plugins with user-configurable settings', async () => {
            const enabledPlugin = createPluginWithSettings('enabled-plugin', 'ai-provider');
            const disabledPlugin = createPluginWithSettings('disabled-plugin', 'deployment');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                enabledPlugin,
                disabledPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'enabled-plugin',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'disabled-plugin',
                    enabled: false,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].category).toBe('ai-provider');
            expect(result.categories[0].plugins).toHaveLength(1);
            expect(result.categories[0].plugins[0].pluginId).toBe('enabled-plugin');
        });

        it('should group plugins by category', async () => {
            const aiPlugin1 = createPluginWithSettings('openai', 'ai-provider');
            const aiPlugin2 = createPluginWithSettings('anthropic', 'ai-provider');
            const deployPlugin = createPluginWithSettings('vercel', 'deployment');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                aiPlugin1,
                aiPlugin2,
                deployPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'openai',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'anthropic',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '3',
                    userId: 'user-1',
                    pluginId: 'vercel',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(2);
            const aiCategory = result.categories.find((c) => c.category === 'ai-provider');
            const deployCategory = result.categories.find((c) => c.category === 'deployment');

            expect(aiCategory).toBeDefined();
            expect(aiCategory!.plugins).toHaveLength(2);
            expect(deployCategory).toBeDefined();
            expect(deployCategory!.plugins).toHaveLength(1);
        });

        it('should filter out hidden plugins', async () => {
            const publicPlugin = createPluginWithSettings('public', 'utility', 'hybrid', 'public');
            const hiddenPlugin = createPluginWithSettings('hidden', 'utility', 'hybrid', 'hidden');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                publicPlugin,
                hiddenPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'public',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'hidden',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].plugins[0].pluginId).toBe('public');
        });

        it('should filter out admin-only configuration mode plugins', async () => {
            const hybridPlugin = createPluginWithSettings('hybrid', 'utility', 'hybrid');
            const adminOnlyPlugin = createPluginWithSettings('admin-only', 'utility', 'admin-only');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                hybridPlugin,
                adminOnlyPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'hybrid',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'admin-only',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].plugins[0].pluginId).toBe('hybrid');
        });

        it('should include admin-only plugins with oauth capability in settings menu', async () => {
            const oauthPlugin: RegisteredPlugin = {
                plugin: {
                    id: 'github',
                    name: 'GitHub',
                    version: '1.0.0',
                    category: 'git-provider',
                    capabilities: ['git-provider', 'oauth'],
                    settingsSchema: {
                        type: 'object',
                        properties: {
                            clientId: {
                                type: 'string',
                                'x-envVar': 'PLUGIN_GITHUB_CLIENT_ID',
                                'x-adminOnly': true,
                            },
                        },
                    },
                    configurationMode: 'admin-only',
                    onLoad: jest.fn().mockResolvedValue(undefined),
                    onUnload: jest.fn().mockResolvedValue(undefined),
                    validateSettings: jest.fn().mockResolvedValue({ valid: true }),
                } as unknown as IPlugin,
                manifest: {
                    id: 'github',
                    name: 'GitHub',
                    version: '1.0.0',
                    description: 'GitHub integration',
                    category: 'git-provider',
                    capabilities: ['git-provider', 'oauth'],
                    visibility: 'user-only',
                    autoEnable: true,
                    systemPlugin: true,
                } as PluginManifest,
                state: 'loaded',
                builtIn: true,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([oauthPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].category).toBe('git-provider');
            expect(result.categories[0].plugins[0].pluginId).toBe('github');
        });

        it('should not include admin-only plugins without oauth capability', async () => {
            const adminOnlyNoOAuth: RegisteredPlugin = {
                plugin: {
                    id: 'internal-tool',
                    name: 'Internal Tool',
                    version: '1.0.0',
                    category: 'utility',
                    capabilities: ['utility'],
                    settingsSchema: {
                        type: 'object',
                        properties: {
                            secret: {
                                type: 'string',
                                'x-envVar': 'INTERNAL_SECRET',
                                'x-adminOnly': true,
                            },
                        },
                    },
                    configurationMode: 'admin-only',
                    onLoad: jest.fn().mockResolvedValue(undefined),
                    onUnload: jest.fn().mockResolvedValue(undefined),
                    validateSettings: jest.fn().mockResolvedValue({ valid: true }),
                } as unknown as IPlugin,
                manifest: {
                    id: 'internal-tool',
                    name: 'Internal Tool',
                    version: '1.0.0',
                    description: 'Internal tool',
                    category: 'utility',
                    capabilities: ['utility'],
                    visibility: 'public',
                    autoEnable: true,
                } as PluginManifest,
                state: 'loaded',
                builtIn: true,
                registeredAt: Date.now(),
                stateHistory: [],
            };

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([adminOnlyNoOAuth]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(0);
        });

        it('should filter out plugins with only hidden or admin-only settings', async () => {
            const normalPlugin = createPluginWithSettings('normal', 'utility');
            const hiddenOnlyPlugin = createPluginWithSettings(
                'hidden-only',
                'utility',
                'hybrid',
                'public',
                false,
                {
                    type: 'object',
                    properties: {
                        secret: { type: 'string', 'x-hidden': true },
                    },
                } as unknown as JsonSchema,
            );

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                normalPlugin,
                hiddenOnlyPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'normal',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'hidden-only',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].plugins[0].pluginId).toBe('normal');
        });

        it('should identify plugins with unconfigured required settings', async () => {
            const configuredPlugin = createPluginWithSettings('configured', 'ai-provider');
            const unconfiguredPlugin = createPluginWithSettings('unconfigured', 'ai-provider');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                configuredPlugin,
                unconfiguredPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'configured',
                    enabled: true,
                    settings: { apiKey: 'configured-key' },
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'unconfigured',
                    enabled: true,
                    settings: {}, // Missing required apiKey
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            const category = result.categories.find((c) => c.category === 'ai-provider');
            expect(category).toBeDefined();

            const configured = category!.plugins.find((p) => p.pluginId === 'configured');
            const unconfigured = category!.plugins.find((p) => p.pluginId === 'unconfigured');

            expect(configured!.hasRequiredSettings).toBe(false);
            expect(unconfigured!.hasRequiredSettings).toBe(true);
        });

        it('should include autoEnabled plugins even without UserPluginEntity', async () => {
            const autoEnabledPlugin = createPluginWithSettings(
                'auto-enabled',
                'ai-provider',
                'hybrid',
                'public',
                true,
            );

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([autoEnabledPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].plugins[0].pluginId).toBe('auto-enabled');
            expect(result.categories[0].plugins[0].enabled).toBe(true);
        });

        it('should format unknown category labels correctly', async () => {
            const unknownCategoryPlugin = createPluginWithSettings('plugin', 'my-custom-category');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([unknownCategoryPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'plugin',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(1);
            expect(result.categories[0].label).toBe('My Custom Category');
        });

        it('should use predefined labels for known categories', async () => {
            const aiPlugin = createPluginWithSettings('openai', 'ai-provider');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([aiPlugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'openai',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories[0].label).toBe('AI Providers');
        });

        it('should sort categories alphabetically by label', async () => {
            const searchPlugin = createPluginWithSettings('tavily', 'search');
            const aiPlugin = createPluginWithSettings('openai', 'ai-provider');
            const deployPlugin = createPluginWithSettings('vercel', 'deployment');

            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([
                searchPlugin,
                aiPlugin,
                deployPlugin,
            ]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'tavily',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '2',
                    userId: 'user-1',
                    pluginId: 'openai',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
                {
                    id: '3',
                    userId: 'user-1',
                    pluginId: 'vercel',
                    enabled: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);

            const result = await service.getPluginsForSettingsMenu('user-1');

            expect(result.categories).toHaveLength(3);
            expect(result.categories[0].label).toBe('AI Providers');
            expect(result.categories[1].label).toBe('Deployment');
            expect(result.categories[2].label).toBe('Search');
        });
    });

    describe('updateUserPluginSettings', () => {
        it('should auto-create user plugin record for autoEnabled plugin without prior record', async () => {
            const autoEnabledPlugin = createRegisteredPlugin();
            autoEnabledPlugin.manifest = {
                ...autoEnabledPlugin.manifest,
                autoEnable: true,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnabledPlugin);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);

            const result = await service.updateUserPluginSettings('test-plugin', 'user-1', {
                normalSetting: 'my-value',
            });

            expect(userPluginRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    pluginEntityId: '1',
                    enabled: true,
                }),
            );
            expect(userPluginRepository.save).toHaveBeenCalled();
            expect(result.installed).toBe(true);
            expect(result.enabled).toBe(true);
        });

        it('should throw for non-autoEnabled plugin without prior record', async () => {
            const normalPlugin = createRegisteredPlugin();
            normalPlugin.manifest = {
                ...normalPlugin.manifest,
                autoEnable: false,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(normalPlugin);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            await expect(
                service.updateUserPluginSettings('test-plugin', 'user-1', {
                    normalSetting: 'value',
                }),
            ).rejects.toThrow(BadRequestException);
        });

        it('should validate combined settings+secretSettings together', async () => {
            const schemaWithRequired: JsonSchema = {
                type: 'object',
                properties: {
                    apiKey: { type: 'string', 'x-secret': true },
                    model: { type: 'string' },
                },
                required: ['apiKey', 'model'],
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schemaWithRequired);
            const registered = createRegisteredPlugin(plugin);
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

            // Send apiKey in secretSettings and model in settings —
            // combined validation should pass (validator is mocked as valid)
            await service.updateUserPluginSettings(
                'test-plugin',
                'user-1',
                { model: 'gpt-4' },
                { apiKey: 'sk-test-key' },
            );

            // Verify the validator received the combined bag
            const validator = (service as any).settingsValidator;
            expect(validator.validate).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'gpt-4',
                    apiKey: 'sk-test-key',
                }),
                schemaWithRequired,
                'user',
            );
        });

        it('should throw NotFoundException when plugin entity not found for autoEnabled plugin', async () => {
            const autoEnabledPlugin = createRegisteredPlugin();
            autoEnabledPlugin.manifest = {
                ...autoEnabledPlugin.manifest,
                autoEnable: true,
            } as PluginManifest;

            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnabledPlugin);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue(null);

            await expect(
                service.updateUserPluginSettings('test-plugin', 'user-1', {
                    normalSetting: 'value',
                }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('autoEnableForDirectories', () => {
        it('should store autoEnableForDirectories when creating new user plugin', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            await service.enablePluginForUser('test-plugin', 'user-1', undefined, undefined, true);

            expect(userPluginRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ autoEnableForDirectories: true }),
            );
            expect(userPluginRepository.save).toHaveBeenCalled();
        });

        it('should default autoEnableForDirectories to false', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

            await service.enablePluginForUser('test-plugin', 'user-1');

            expect(userPluginRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ autoEnableForDirectories: false }),
            );
        });

        it('should update autoEnableForDirectories on existing user plugin', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);
            const existing = {
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: false,
                autoEnableForDirectories: false,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any;
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(existing);

            await service.enablePluginForUser('test-plugin', 'user-1', undefined, undefined, true);

            expect(userPluginRepository.save).toHaveBeenCalledWith(
                expect.objectContaining({ autoEnableForDirectories: true }),
            );
        });

        it('should include autoEnableForDirectories in user plugin response', async () => {
            const registered = createRegisteredPlugin();
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                autoEnableForDirectories: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);

            const result = await service.getPlugin('test-plugin', 'user-1');

            expect(result.autoEnableForDirectories).toBe(true);
        });

        it('should use autoEnableForDirectories in directory plugin response', async () => {
            const plugin = createRegisteredPlugin();
            plugin.manifest = { ...plugin.manifest, autoEnable: false } as PluginManifest;
            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([plugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    autoEnableForDirectories: true,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);
            jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.listDirectoryPlugins('dir-1', 'user-1');

            expect(result.plugins[0].directoryEnabled).toBe(true);
        });

        it('should respect autoEnableForDirectories=false even when manifest autoEnable=true', async () => {
            const plugin = createRegisteredPlugin();
            plugin.manifest = { ...plugin.manifest, autoEnable: true } as PluginManifest;
            jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([plugin]);
            jest.spyOn(userPluginRepository, 'find').mockResolvedValue([
                {
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: true,
                    autoEnableForDirectories: false,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any,
            ]);
            jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

            const result = await service.listDirectoryPlugins('dir-1', 'user-1');

            // User explicitly chose autoEnableForDirectories=false, so plugin is NOT
            // enabled at directory level despite manifest autoEnable=true
            expect(result.plugins[0].directoryEnabled).toBe(false);
        });

        it('should auto-create directory record in updateDirectoryPluginSettings when user has autoEnableForDirectories', async () => {
            const registered = createRegisteredPlugin();
            registered.manifest = { ...registered.manifest, autoEnable: false } as PluginManifest;
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                autoEnableForDirectories: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue(null);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);

            await service.updateDirectoryPluginSettings('dir-1', 'test-plugin', 'user-1', {
                normalSetting: 'val',
            });

            expect(directoryPluginRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ enabled: true }),
            );
            expect(directoryPluginRepository.save).toHaveBeenCalled();
        });

        it('should auto-create directory record in setActiveCapability when user has autoEnableForDirectories', async () => {
            const registered = createRegisteredPlugin();
            registered.manifest = { ...registered.manifest, autoEnable: false } as PluginManifest;
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                autoEnableForDirectories: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue(null);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);

            await service.setActiveCapability('dir-1', 'test-plugin', 'user-1', 'test');

            expect(directoryPluginRepository.save).toHaveBeenCalled();
        });

        it('should throw in updateDirectoryPluginSettings when user has plugin disabled', async () => {
            const registered = createRegisteredPlugin();
            registered.manifest = { ...registered.manifest, autoEnable: false } as PluginManifest;
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: false,
                autoEnableForDirectories: false,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue(null);

            await expect(
                service.updateDirectoryPluginSettings('dir-1', 'test-plugin', 'user-1', {
                    normalSetting: 'val',
                }),
            ).rejects.toThrow(BadRequestException);
        });

        it('should create opt-out record when disabling auto-enabled plugin for directory', async () => {
            const registered = createRegisteredPlugin();
            registered.manifest = { ...registered.manifest, autoEnable: false } as PluginManifest;
            jest.spyOn(pluginRegistryService, 'get').mockReturnValue(registered);
            jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                enabled: true,
                autoEnableForDirectories: true,
                settings: {},
                secretSettings: {},
                metadata: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue(null);
            jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
            } as any);

            await service.disablePluginForDirectory('dir-1', 'test-plugin', 'user-1');

            expect(directoryPluginRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ enabled: false }),
            );
            expect(directoryPluginRepository.save).toHaveBeenCalled();
        });
    });

    describe('autoEnable behavior', () => {
        describe('toUserPluginResponse with autoEnable', () => {
            it('should show autoEnabled plugin as installed and enabled without UserPluginEntity', async () => {
                const autoEnabledPlugin = createRegisteredPlugin();
                autoEnabledPlugin.manifest = {
                    ...autoEnabledPlugin.manifest,
                    autoEnable: true,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnabledPlugin);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.installed).toBe(true);
                expect(result.enabled).toBe(true);
            });

            it('should respect explicit disabled status for autoEnabled plugin', async () => {
                const autoEnabledPlugin = createRegisteredPlugin();
                autoEnabledPlugin.manifest = {
                    ...autoEnabledPlugin.manifest,
                    autoEnable: true,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnabledPlugin);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: false, // Explicitly disabled
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.installed).toBe(true);
                expect(result.enabled).toBe(false);
            });

            it('should show non-autoEnabled plugin as not installed without UserPluginEntity', async () => {
                const normalPlugin = createRegisteredPlugin();
                normalPlugin.manifest = {
                    ...normalPlugin.manifest,
                    autoEnable: false,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(normalPlugin);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

                const result = await service.getPlugin('test-plugin', 'user-1');

                expect(result.installed).toBe(false);
                expect(result.enabled).toBe(false);
            });
        });

        describe('toDirectoryPluginResponse with autoEnable', () => {
            it('should show autoEnabled plugin as directoryEnabled without DirectoryPluginEntity', async () => {
                const autoEnabledPlugin = createRegisteredPlugin();
                autoEnabledPlugin.manifest = {
                    ...autoEnabledPlugin.manifest,
                    autoEnable: true,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([autoEnabledPlugin]);
                jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);
                jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

                const result = await service.listDirectoryPlugins('dir-1', 'user-1');

                expect(result.plugins[0].directoryEnabled).toBe(true);
            });

            it('should respect explicit disabled status for autoEnabled plugin at directory level', async () => {
                const autoEnabledPlugin = createRegisteredPlugin();
                autoEnabledPlugin.manifest = {
                    ...autoEnabledPlugin.manifest,
                    autoEnable: true,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([autoEnabledPlugin]);
                jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);
                jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([
                    {
                        id: '1',
                        directoryId: 'dir-1',
                        pluginId: 'test-plugin',
                        enabled: false, // Explicitly disabled
                        settings: {},
                        secretSettings: {},
                        metadata: {},
                    } as any,
                ]);

                const result = await service.listDirectoryPlugins('dir-1', 'user-1');

                expect(result.plugins[0].directoryEnabled).toBe(false);
            });

            it('should show non-autoEnabled plugin as not directoryEnabled without DirectoryPluginEntity', async () => {
                const normalPlugin = createRegisteredPlugin();
                normalPlugin.manifest = {
                    ...normalPlugin.manifest,
                    autoEnable: false,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'getAll').mockReturnValue([normalPlugin]);
                jest.spyOn(userPluginRepository, 'find').mockResolvedValue([]);
                jest.spyOn(directoryPluginRepository, 'find').mockResolvedValue([]);

                const result = await service.listDirectoryPlugins('dir-1', 'user-1');

                expect(result.plugins[0].directoryEnabled).toBe(false);
            });
        });

        describe('enablePluginForDirectory with autoEnable', () => {
            it('should allow enabling autoEnabled plugin for directory without UserPluginEntity', async () => {
                const autoEnabledPlugin = createRegisteredPlugin();
                autoEnabledPlugin.manifest = {
                    ...autoEnabledPlugin.manifest,
                    autoEnable: true,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(autoEnabledPlugin);
                jest.spyOn(pluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                } as any);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);
                jest.spyOn(directoryPluginRepository, 'findOne').mockResolvedValue(null);

                const result = await service.enablePluginForDirectory(
                    'dir-1',
                    'test-plugin',
                    'user-1',
                );

                expect(result.directoryEnabled).toBe(true);
                expect(directoryPluginRepository.save).toHaveBeenCalled();
            });

            it('should reject non-autoEnabled plugin without UserPluginEntity', async () => {
                const normalPlugin = createRegisteredPlugin();
                normalPlugin.manifest = {
                    ...normalPlugin.manifest,
                    autoEnable: false,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(normalPlugin);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue(null);

                await expect(
                    service.enablePluginForDirectory('dir-1', 'test-plugin', 'user-1'),
                ).rejects.toThrow(BadRequestException);
            });

            it('should reject non-autoEnabled plugin with disabled UserPluginEntity', async () => {
                const normalPlugin = createRegisteredPlugin();
                normalPlugin.manifest = {
                    ...normalPlugin.manifest,
                    autoEnable: false,
                } as PluginManifest;

                jest.spyOn(pluginRegistryService, 'get').mockReturnValue(normalPlugin);
                jest.spyOn(userPluginRepository, 'findOne').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    enabled: false,
                    settings: {},
                    secretSettings: {},
                    metadata: {},
                } as any);

                await expect(
                    service.enablePluginForDirectory('dir-1', 'test-plugin', 'user-1'),
                ).rejects.toThrow(BadRequestException);
            });
        });
    });
});

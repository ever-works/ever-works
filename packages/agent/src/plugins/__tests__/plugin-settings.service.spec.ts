import { Test, TestingModule } from '@nestjs/testing';
import { Logger, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginSettingsService } from '../services/plugin-settings.service';
import { PluginRegistryService, RegisteredPlugin } from '../services/plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';
import { DirectoryPluginRepository } from '../repositories/directory-plugin.repository';
import { PluginEvents } from '../plugins.constants';
import type { IPlugin, PluginManifest, JsonSchema } from '@ever-works/plugin';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('PluginSettingsService', () => {
    let service: PluginSettingsService;
    let registry: PluginRegistryService;
    let pluginRepository: PluginRepository;
    let userPluginRepository: UserPluginRepository;
    let directoryPluginRepository: DirectoryPluginRepository;
    let eventEmitter: EventEmitter2;

    const createSettingsSchema = (): JsonSchema =>
        ({
            type: 'object',
            properties: {
                apiKey: {
                    type: 'string',
                    'x-secret': true,
                    'x-envVar': 'PLUGIN_API_KEY',
                },
                secretToken: {
                    type: 'string',
                    'x-secret': true,
                    // Note: no x-envVar, so this can be stored in DB
                },
                enabled: {
                    type: 'boolean',
                    default: true,
                },
                maxItems: {
                    type: 'number',
                    default: 10,
                    'x-scope': 'directory',
                },
                theme: {
                    type: 'string',
                    default: 'light',
                    'x-scope': 'user',
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
                PluginSettingsService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn().mockReturnValue(createRegisteredPlugin()),
                    },
                },
                {
                    provide: PluginRepository,
                    useValue: {
                        findByPluginId: jest.fn().mockResolvedValue(null),
                        updateSettings: jest.fn().mockResolvedValue({}),
                    },
                },
                {
                    provide: UserPluginRepository,
                    useValue: {
                        findByUserAndPlugin: jest.fn().mockResolvedValue(null),
                        updateSettings: jest.fn().mockResolvedValue({}),
                        create: jest.fn().mockResolvedValue({}),
                        deleteByUserAndPlugin: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: DirectoryPluginRepository,
                    useValue: {
                        findByDirectoryAndPlugin: jest.fn().mockResolvedValue(null),
                        updateSettings: jest.fn().mockResolvedValue({}),
                        create: jest.fn().mockResolvedValue({}),
                        deleteByDirectoryAndPlugin: jest.fn().mockResolvedValue(true),
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

        service = module.get<PluginSettingsService>(PluginSettingsService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        pluginRepository = module.get<PluginRepository>(PluginRepository);
        userPluginRepository = module.get<UserPluginRepository>(UserPluginRepository);
        directoryPluginRepository =
            module.get<DirectoryPluginRepository>(DirectoryPluginRepository);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    });

    describe('getResolvedSettings', () => {
        it('should throw error for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            await expect(service.getResolvedSettings('non-existent')).rejects.toThrow(
                'Plugin "non-existent" not found',
            );
        });

        it('should return default values when no settings are stored', async () => {
            const result = await service.getResolvedSettings('test-plugin');

            expect(result.enabled).toEqual({
                key: 'enabled',
                value: true,
                source: 'default',
                isFallback: true,
            });
            expect(result.maxItems).toEqual({
                key: 'maxItems',
                value: 10,
                source: 'default',
                isFallback: true,
            });
        });

        it('should resolve admin settings over defaults', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: { enabled: false },
                secretSettings: {},
            } as any);

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.enabled).toEqual({
                key: 'enabled',
                value: false,
                source: 'admin',
                isFallback: false,
            });
        });

        it('should resolve user settings over admin settings', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: { theme: 'dark' },
                secretSettings: {},
            } as any);

            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                settings: { theme: 'blue' },
                secretSettings: {},
            } as any);

            const result = await service.getResolvedSettings('test-plugin', { userId: 'user-1' });

            expect(result.theme).toEqual({
                key: 'theme',
                value: 'blue',
                source: 'user',
                isFallback: false,
            });
        });

        it('should resolve directory settings over user settings', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: { maxItems: 20 },
                secretSettings: {},
            } as any);

            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                settings: { maxItems: 30 },
                secretSettings: {},
            } as any);

            jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue({
                id: '1',
                directoryId: 'dir-1',
                pluginId: 'test-plugin',
                settings: { maxItems: 50 },
                secretSettings: {},
            } as any);

            const result = await service.getResolvedSettings('test-plugin', {
                userId: 'user-1',
                directoryId: 'dir-1',
            });

            expect(result.maxItems).toEqual({
                key: 'maxItems',
                value: 50,
                source: 'directory',
                isFallback: false,
            });
        });

        it('should resolve from environment variable', async () => {
            const originalEnv = process.env.PLUGIN_API_KEY;
            process.env.PLUGIN_API_KEY = 'env-api-key';

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.apiKey).toEqual({
                key: 'apiKey',
                value: 'env-api-key',
                source: 'env',
                isFallback: true,
            });

            // Restore
            if (originalEnv !== undefined) {
                process.env.PLUGIN_API_KEY = originalEnv;
            } else {
                delete process.env.PLUGIN_API_KEY;
            }
        });

        it('should include secrets when requested', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: { apiKey: 'secret-key' },
            } as any);

            const result = await service.getResolvedSettings('test-plugin', {
                includeSecrets: true,
            });

            expect(result.apiKey.value).toBe('secret-key');
        });

        it('should exclude secrets when not requested', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: { apiKey: 'secret-key' },
            } as any);

            const result = await service.getResolvedSettings('test-plugin', {
                includeSecrets: false,
            });

            expect(result.apiKey.source).toBe('default');
        });
    });

    describe('getSettings', () => {
        it('should return plain settings values', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: { enabled: false, maxItems: 25 },
                secretSettings: {},
            } as any);

            const result = await service.getSettings('test-plugin');

            expect(result).toEqual({
                apiKey: undefined,
                enabled: false,
                maxItems: 25,
                theme: 'light',
            });
        });
    });

    describe('updateAdminSettings', () => {
        it('should throw error for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            await expect(service.updateAdminSettings('non-existent', {})).rejects.toThrow(
                'Plugin "non-existent" not found',
            );
        });

        it('should throw error for invalid settings', async () => {
            const plugin = createMockPlugin();
            (plugin.validateSettings as jest.Mock).mockResolvedValue({
                valid: false,
                errors: [{ path: 'enabled', message: 'Must be boolean' }],
            });
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            await expect(
                service.updateAdminSettings('test-plugin', { enabled: 'not-boolean' }),
            ).rejects.toThrow('Invalid settings');
        });

        it('should update admin settings', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: { enabled: true },
                secretSettings: {},
            } as any);

            await service.updateAdminSettings('test-plugin', { enabled: false });

            expect(pluginRepository.updateSettings).toHaveBeenCalledWith(
                'test-plugin',
                { enabled: false },
                {},
            );
        });

        it('should separate secret settings', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            // Use secretToken (which has x-secret but NOT x-envVar)
            // apiKey has x-envVar and would be filtered out
            await service.updateAdminSettings('test-plugin', {
                enabled: true,
                secretToken: 'new-secret-token',
            });

            expect(pluginRepository.updateSettings).toHaveBeenCalledWith(
                'test-plugin',
                { enabled: true },
                { secretToken: 'new-secret-token' },
            );
        });

        it('should emit settings changed event', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            await service.updateAdminSettings('test-plugin', { enabled: false });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.SETTINGS_CHANGED,
                expect.objectContaining({
                    pluginId: 'test-plugin',
                    changedKeys: ['enabled'],
                    scope: 'global',
                }),
            );
        });

        it('should use explicit secretKeys option', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            await service.updateAdminSettings(
                'test-plugin',
                { customSecret: 'value', enabled: true },
                { secretKeys: ['customSecret'] },
            );

            expect(pluginRepository.updateSettings).toHaveBeenCalledWith(
                'test-plugin',
                { enabled: true },
                { customSecret: 'value' },
            );
        });
    });

    describe('updateUserSettings', () => {
        it('should throw error for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            await expect(service.updateUserSettings('non-existent', 'user-1', {})).rejects.toThrow(
                'Plugin "non-existent" not found',
            );
        });

        it('should create user settings if not exists', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue(null);

            await service.updateUserSettings('test-plugin', 'user-1', { theme: 'dark' });

            expect(userPluginRepository.create).toHaveBeenCalledWith({
                userId: 'user-1',
                pluginId: 'test-plugin',
                pluginEntityId: '1',
                settings: { theme: 'dark' },
                secretSettings: {},
            });
        });

        it('should update existing user settings', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue({
                id: '1',
                userId: 'user-1',
                pluginId: 'test-plugin',
                settings: { theme: 'light' },
                secretSettings: {},
            } as any);

            await service.updateUserSettings('test-plugin', 'user-1', { theme: 'dark' });

            expect(userPluginRepository.updateSettings).toHaveBeenCalledWith(
                'user-1',
                'test-plugin',
                { theme: 'dark' },
                {},
            );
        });

        it('should emit settings changed event', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue(null);

            await service.updateUserSettings('test-plugin', 'user-1', { theme: 'dark' });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.SETTINGS_CHANGED,
                expect.objectContaining({
                    pluginId: 'test-plugin',
                    scope: 'user',
                    userId: 'user-1',
                }),
            );
        });

        it('should throw if plugin entity not found', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue(null);

            await expect(
                service.updateUserSettings('test-plugin', 'user-1', { theme: 'dark' }),
            ).rejects.toThrow('Plugin entity not found');
        });
    });

    describe('updateDirectorySettings', () => {
        it('should throw error for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            await expect(
                service.updateDirectorySettings('non-existent', 'dir-1', {}),
            ).rejects.toThrow('Plugin "non-existent" not found');
        });

        it('should create directory settings if not exists', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue(
                null,
            );

            await service.updateDirectorySettings('test-plugin', 'dir-1', { maxItems: 25 });

            expect(directoryPluginRepository.create).toHaveBeenCalledWith({
                directoryId: 'dir-1',
                pluginId: 'test-plugin',
                pluginEntityId: '1',
                settings: { maxItems: 25 },
                secretSettings: {},
            });
        });

        it('should update existing directory settings', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue({
                id: '1',
                directoryId: 'dir-1',
                pluginId: 'test-plugin',
                settings: { maxItems: 10 },
                secretSettings: {},
            } as any);

            await service.updateDirectorySettings('test-plugin', 'dir-1', { maxItems: 25 });

            expect(directoryPluginRepository.updateSettings).toHaveBeenCalledWith(
                'dir-1',
                'test-plugin',
                { maxItems: 25 },
                {},
            );
        });

        it('should emit settings changed event', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue(
                null,
            );

            await service.updateDirectorySettings('test-plugin', 'dir-1', { maxItems: 25 });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.SETTINGS_CHANGED,
                expect.objectContaining({
                    pluginId: 'test-plugin',
                    scope: 'directory',
                    directoryId: 'dir-1',
                }),
            );
        });
    });

    describe('deleteUserSettings', () => {
        it('should delete user settings', async () => {
            const result = await service.deleteUserSettings('test-plugin', 'user-1');

            expect(result).toBe(true);
            expect(userPluginRepository.deleteByUserAndPlugin).toHaveBeenCalledWith(
                'user-1',
                'test-plugin',
            );
        });
    });

    describe('deleteDirectorySettings', () => {
        it('should delete directory settings', async () => {
            const result = await service.deleteDirectorySettings('test-plugin', 'dir-1');

            expect(result).toBe(true);
            expect(directoryPluginRepository.deleteByDirectoryAndPlugin).toHaveBeenCalledWith(
                'dir-1',
                'test-plugin',
            );
        });
    });

    describe('getSettingsSchema', () => {
        it('should return settings schema', () => {
            const result = service.getSettingsSchema('test-plugin');

            expect(result).toBeDefined();
            expect(result?.type).toBe('object');
            expect(result?.properties).toBeDefined();
        });

        it('should return undefined for non-existent plugin', () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = service.getSettingsSchema('non-existent');

            expect(result).toBeUndefined();
        });
    });

    describe('validateSettings', () => {
        it('should return valid for valid settings', async () => {
            const result = await service.validateSettings('test-plugin', { enabled: true });

            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        it('should return invalid for invalid settings', async () => {
            const plugin = createMockPlugin();
            (plugin.validateSettings as jest.Mock).mockResolvedValue({
                valid: false,
                errors: [{ path: 'enabled', message: 'Must be boolean' }],
            });
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.validateSettings('test-plugin', {
                enabled: 'not-boolean',
            });

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Must be boolean');
        });

        it('should return invalid for non-existent plugin', async () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = await service.validateSettings('non-existent', {});

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Plugin "non-existent" not found');
        });
    });

    describe('environment variable parsing', () => {
        it('should parse boolean true from env', async () => {
            const originalEnv = process.env.TEST_BOOL;
            process.env.TEST_BOOL = 'true';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testBool: {
                        type: 'boolean',
                        'x-envVar': 'TEST_BOOL',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testBool.value).toBe(true);

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_BOOL = originalEnv;
            } else {
                delete process.env.TEST_BOOL;
            }
        });

        it('should parse boolean from "1"', async () => {
            const originalEnv = process.env.TEST_BOOL;
            process.env.TEST_BOOL = '1';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testBool: {
                        type: 'boolean',
                        'x-envVar': 'TEST_BOOL',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testBool.value).toBe(true);

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_BOOL = originalEnv;
            } else {
                delete process.env.TEST_BOOL;
            }
        });

        it('should parse number from env', async () => {
            const originalEnv = process.env.TEST_NUM;
            process.env.TEST_NUM = '42';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testNum: {
                        type: 'number',
                        'x-envVar': 'TEST_NUM',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testNum.value).toBe(42);

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_NUM = originalEnv;
            } else {
                delete process.env.TEST_NUM;
            }
        });

        it('should parse array from JSON string', async () => {
            const originalEnv = process.env.TEST_ARR;
            process.env.TEST_ARR = '["a","b","c"]';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testArr: {
                        type: 'array',
                        'x-envVar': 'TEST_ARR',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testArr.value).toEqual(['a', 'b', 'c']);

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_ARR = originalEnv;
            } else {
                delete process.env.TEST_ARR;
            }
        });

        it('should parse array from comma-separated string', async () => {
            const originalEnv = process.env.TEST_ARR;
            process.env.TEST_ARR = 'a, b, c';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testArr: {
                        type: 'array',
                        'x-envVar': 'TEST_ARR',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testArr.value).toEqual(['a', 'b', 'c']);

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_ARR = originalEnv;
            } else {
                delete process.env.TEST_ARR;
            }
        });

        it('should parse object from JSON string', async () => {
            const originalEnv = process.env.TEST_OBJ;
            process.env.TEST_OBJ = '{"key":"value"}';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testObj: {
                        type: 'object',
                        'x-envVar': 'TEST_OBJ',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testObj.value).toEqual({ key: 'value' });

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_OBJ = originalEnv;
            } else {
                delete process.env.TEST_OBJ;
            }
        });

        it('should return empty object for invalid JSON object', async () => {
            const originalEnv = process.env.TEST_OBJ;
            process.env.TEST_OBJ = 'not-json';

            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    testObj: {
                        type: 'object',
                        'x-envVar': 'TEST_OBJ',
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.getResolvedSettings('test-plugin');

            expect(result.testObj.value).toEqual({});

            // Cleanup
            if (originalEnv !== undefined) {
                process.env.TEST_OBJ = originalEnv;
            } else {
                delete process.env.TEST_OBJ;
            }
        });
    });

    describe('scope validation', () => {
        it('should reject directory-scoped settings at global level', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            // maxItems has 'x-scope': 'directory'
            await expect(
                service.updateAdminSettings('test-plugin', { maxItems: 50 }),
            ).rejects.toThrow('Scope violation');
        });

        it('should reject directory-scoped settings at user level', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue(null);

            // maxItems has 'x-scope': 'directory'
            await expect(
                service.updateUserSettings('test-plugin', 'user-1', { maxItems: 50 }),
            ).rejects.toThrow('Scope violation');
        });

        it('should allow global-scoped settings at any level', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue(
                null,
            );

            // enabled has no x-scope (defaults to 'global')
            await expect(
                service.updateDirectorySettings('test-plugin', 'dir-1', { enabled: false }),
            ).resolves.not.toThrow();
        });

        it('should allow user-scoped settings at user level', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue(null);

            // theme has 'x-scope': 'user'
            await expect(
                service.updateUserSettings('test-plugin', 'user-1', { theme: 'dark' }),
            ).resolves.not.toThrow();
        });

        it('should reject user-scoped settings at global level', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            // theme has 'x-scope': 'user'
            await expect(
                service.updateAdminSettings('test-plugin', { theme: 'dark' }),
            ).rejects.toThrow('Scope violation');
        });

        it('should allow directory-scoped settings at directory level', async () => {
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);
            jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue(
                null,
            );

            // maxItems has 'x-scope': 'directory'
            await expect(
                service.updateDirectorySettings('test-plugin', 'dir-1', { maxItems: 50 }),
            ).resolves.not.toThrow();
        });
    });

    describe('requiresRestart handling', () => {
        it('should include requiresRestart in event when setting has x-requiresRestart', async () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    port: {
                        type: 'number',
                        default: 3000,
                        'x-requiresRestart': true,
                    },
                    debug: {
                        type: 'boolean',
                        default: false,
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            await service.updateAdminSettings('test-plugin', { port: 8080 });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.SETTINGS_CHANGED,
                expect.objectContaining({
                    requiresRestart: true,
                }),
            );
        });

        it('should not set requiresRestart when setting does not have x-requiresRestart', async () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    debug: {
                        type: 'boolean',
                        default: false,
                    },
                },
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
            jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                id: '1',
                pluginId: 'test-plugin',
                settings: {},
                secretSettings: {},
            } as any);

            await service.updateAdminSettings('test-plugin', { debug: true });

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.SETTINGS_CHANGED,
                expect.objectContaining({
                    requiresRestart: false,
                }),
            );
        });
    });

    describe('getSettingsSchemaForContext', () => {
        it('should filter properties for user context', () => {
            // Default schema has: apiKey (global), enabled (global), maxItems (directory), theme (user)
            const result = service.getSettingsSchemaForContext('test-plugin', 'user');

            expect(result).toBeDefined();
            expect(result?.properties).toBeDefined();
            expect('apiKey' in result!.properties!).toBe(true); // global
            expect('enabled' in result!.properties!).toBe(true); // global
            expect('theme' in result!.properties!).toBe(true); // user
            expect('maxItems' in result!.properties!).toBe(false); // directory - should be filtered out
        });

        it('should filter properties for directory context', () => {
            const result = service.getSettingsSchemaForContext('test-plugin', 'directory');

            expect(result).toBeDefined();
            expect(result?.properties).toBeDefined();
            expect('apiKey' in result!.properties!).toBe(true); // global
            expect('enabled' in result!.properties!).toBe(true); // global
            expect('maxItems' in result!.properties!).toBe(true); // directory
            expect('theme' in result!.properties!).toBe(false); // user - should be filtered out
        });

        it('should return undefined for non-existent plugin', () => {
            jest.spyOn(registry, 'get').mockReturnValue(undefined);

            const result = service.getSettingsSchemaForContext('non-existent', 'user');

            expect(result).toBeUndefined();
        });

        it('should filter required array to only included properties', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    globalSetting: {
                        type: 'string',
                    },
                    directorySetting: {
                        type: 'string',
                        'x-scope': 'directory',
                    },
                },
                required: ['globalSetting', 'directorySetting'],
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = service.getSettingsSchemaForContext('test-plugin', 'user');

            expect(result?.required).toEqual(['globalSetting']);
            expect(result?.required).not.toContain('directorySetting');
        });

        it('should return schema unchanged if no properties', () => {
            const schema: JsonSchema = {
                type: 'object',
            } as unknown as JsonSchema;

            const plugin = createMockPlugin(schema);
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = service.getSettingsSchemaForContext('test-plugin', 'user');

            expect(result).toEqual(schema);
        });
    });

    describe('validateScopeRequirements', () => {
        it('should throw BadRequestException for directory scope without directoryId', () => {
            expect(() => {
                service.validateScopeRequirements('directory', undefined, 'user-1');
            }).toThrow(BadRequestException);
            expect(() => {
                service.validateScopeRequirements('directory', undefined, 'user-1');
            }).toThrow('directoryId required for directory scope');
        });

        it('should throw BadRequestException for user scope without userId', () => {
            expect(() => {
                service.validateScopeRequirements('user', 'dir-1', undefined);
            }).toThrow(BadRequestException);
            expect(() => {
                service.validateScopeRequirements('user', 'dir-1', undefined);
            }).toThrow('userId required for user scope');
        });

        it('should not throw for directory scope with directoryId', () => {
            expect(() => {
                service.validateScopeRequirements('directory', 'dir-1', undefined);
            }).not.toThrow();
        });

        it('should not throw for user scope with userId', () => {
            expect(() => {
                service.validateScopeRequirements('user', undefined, 'user-1');
            }).not.toThrow();
        });

        it('should not throw for global scope without any IDs', () => {
            expect(() => {
                service.validateScopeRequirements('global', undefined, undefined);
            }).not.toThrow();
        });
    });

    describe('validateSettings with scope option', () => {
        it('should validate scope when scope option is provided', async () => {
            const result = await service.validateSettings(
                'test-plugin',
                { maxItems: 50 }, // directory-scoped setting
                { scope: 'global' }, // trying to set at global scope
            );

            expect(result.valid).toBe(false);
            expect(result.errors).toContain(
                'Setting "maxItems" has scope "directory" and cannot be updated at "global" level',
            );
        });

        it('should pass validation when scope matches', async () => {
            const result = await service.validateSettings(
                'test-plugin',
                { maxItems: 50 },
                { scope: 'directory' },
            );

            expect(result.valid).toBe(true);
        });

        it('should validate both scope and schema', async () => {
            const plugin = createMockPlugin();
            (plugin.validateSettings as jest.Mock).mockResolvedValue({
                valid: false,
                errors: [{ path: 'maxItems', message: 'Must be a number' }],
            });
            jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));

            const result = await service.validateSettings(
                'test-plugin',
                { maxItems: 'not-a-number' },
                { scope: 'global' },
            );

            expect(result.valid).toBe(false);
            // Should have both scope violation and schema validation error
            expect(result.errors).toHaveLength(2);
        });

        it('should skip scope validation when no scope option provided', async () => {
            const result = await service.validateSettings('test-plugin', { maxItems: 50 });

            // Without scope option, only schema validation runs
            expect(result.valid).toBe(true);
        });
    });

    describe('x-envVar security filtering', () => {
        const createSchemaWithEnvVars = (): JsonSchema =>
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
                    normalSetting: {
                        type: 'string',
                        default: 'default-value',
                    },
                    apiBaseUrl: {
                        type: 'string',
                        'x-envVar': 'TEST_API_URL',
                        default: 'https://api.example.com',
                    },
                },
            }) as unknown as JsonSchema;

        describe('updateAdminSettings', () => {
            it('should filter out x-envVar fields when updating admin settings', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);

                await service.updateAdminSettings('test-plugin', {
                    clientId: 'should-be-filtered',
                    clientSecret: 'should-also-be-filtered',
                    normalSetting: 'should-be-saved',
                });

                // x-envVar fields should NOT be saved
                expect(pluginRepository.updateSettings).toHaveBeenCalledWith(
                    'test-plugin',
                    { normalSetting: 'should-be-saved' },
                    {},
                );
            });

            it('should log warning when x-envVar field is rejected', async () => {
                const warnSpy = jest.spyOn(Logger.prototype, 'warn');
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);

                await service.updateAdminSettings('test-plugin', {
                    clientId: 'should-be-filtered',
                });

                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Rejecting x-envVar field "clientId"'),
                );
            });

            it('should allow non-x-envVar fields to be stored normally', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: { existing: 'value' },
                    secretSettings: {},
                } as any);

                await service.updateAdminSettings('test-plugin', {
                    normalSetting: 'new-value',
                });

                expect(pluginRepository.updateSettings).toHaveBeenCalledWith(
                    'test-plugin',
                    { existing: 'value', normalSetting: 'new-value' },
                    {},
                );
            });

            it('should filter x-envVar but keep other settings in same request', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);

                await service.updateAdminSettings('test-plugin', {
                    clientId: 'env-var-filtered',
                    apiBaseUrl: 'also-env-var-filtered',
                    normalSetting: 'this-should-be-saved',
                });

                expect(pluginRepository.updateSettings).toHaveBeenCalledWith(
                    'test-plugin',
                    { normalSetting: 'this-should-be-saved' },
                    {},
                );
            });
        });

        describe('updateUserSettings', () => {
            it('should filter out x-envVar fields when updating user settings', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);
                jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue(null);

                await service.updateUserSettings('test-plugin', 'user-1', {
                    clientId: 'should-be-filtered',
                    normalSetting: 'should-be-saved',
                });

                expect(userPluginRepository.create).toHaveBeenCalledWith({
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    pluginEntityId: '1',
                    settings: { normalSetting: 'should-be-saved' },
                    secretSettings: {},
                });
            });

            it('should filter x-envVar fields when updating existing user settings', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);
                jest.spyOn(userPluginRepository, 'findByUserAndPlugin').mockResolvedValue({
                    id: '1',
                    userId: 'user-1',
                    pluginId: 'test-plugin',
                    settings: { normalSetting: 'old-value' },
                    secretSettings: {},
                } as any);

                await service.updateUserSettings('test-plugin', 'user-1', {
                    clientId: 'should-be-filtered',
                    normalSetting: 'new-value',
                });

                expect(userPluginRepository.updateSettings).toHaveBeenCalledWith(
                    'user-1',
                    'test-plugin',
                    { normalSetting: 'new-value' },
                    {},
                );
            });
        });

        describe('updateDirectorySettings', () => {
            it('should filter out x-envVar fields when updating directory settings', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);
                jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue(
                    null,
                );

                await service.updateDirectorySettings('test-plugin', 'dir-1', {
                    clientId: 'should-be-filtered',
                    normalSetting: 'should-be-saved',
                });

                expect(directoryPluginRepository.create).toHaveBeenCalledWith({
                    directoryId: 'dir-1',
                    pluginId: 'test-plugin',
                    pluginEntityId: '1',
                    settings: { normalSetting: 'should-be-saved' },
                    secretSettings: {},
                });
            });

            it('should filter x-envVar fields when updating existing directory settings', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);
                jest.spyOn(directoryPluginRepository, 'findByDirectoryAndPlugin').mockResolvedValue(
                    {
                        id: '1',
                        directoryId: 'dir-1',
                        pluginId: 'test-plugin',
                        settings: { normalSetting: 'old-value' },
                        secretSettings: {},
                    } as any,
                );

                await service.updateDirectorySettings('test-plugin', 'dir-1', {
                    clientSecret: 'should-be-filtered',
                    normalSetting: 'new-value',
                });

                expect(directoryPluginRepository.updateSettings).toHaveBeenCalledWith(
                    'dir-1',
                    'test-plugin',
                    { normalSetting: 'new-value' },
                    {},
                );
            });
        });

        describe('event emission with filtered fields', () => {
            it('should emit event with only filtered keys in changedKeys', async () => {
                const schema = createSchemaWithEnvVars();
                const plugin = createMockPlugin(schema);
                jest.spyOn(registry, 'get').mockReturnValue(createRegisteredPlugin(plugin));
                jest.spyOn(pluginRepository, 'findByPluginId').mockResolvedValue({
                    id: '1',
                    pluginId: 'test-plugin',
                    settings: {},
                    secretSettings: {},
                } as any);

                await service.updateAdminSettings('test-plugin', {
                    clientId: 'filtered',
                    normalSetting: 'saved',
                });

                expect(eventEmitter.emit).toHaveBeenCalledWith(
                    PluginEvents.SETTINGS_CHANGED,
                    expect.objectContaining({
                        changedKeys: ['normalSetting'],
                    }),
                );
            });
        });
    });
});

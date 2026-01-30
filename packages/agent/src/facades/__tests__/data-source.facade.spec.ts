import { Test, TestingModule } from '@nestjs/testing';
import { DataSourceFacadeService, DataSourceFacadeError } from '../data-source.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../../plugins/repositories/user-plugin.repository';
import type {
    IDataSourcePlugin,
    PluginManifest,
    DataSourceQueryResult,
    MutableItemData,
} from '@ever-works/plugin';

describe('DataSourceFacadeService', () => {
    let service: DataSourceFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;
    let directoryPluginRepository: jest.Mocked<DirectoryPluginRepository>;
    let userPluginRepository: jest.Mocked<UserPluginRepository>;

    const createMockDataSourcePlugin = (id: string, sourceName: string): IDataSourcePlugin => ({
        id,
        name: `${sourceName} Data Source`,
        version: '1.0.0',
        category: 'data-source',
        capabilities: ['data-source'],
        settingsSchema: { type: 'object', properties: {} },
        sourceName,
        onLoad: jest.fn(),
        onEnable: jest.fn(),
        onDisable: jest.fn(),
        onUnload: jest.fn(),
        validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        query: jest.fn().mockResolvedValue({
            items: [],
            hasMore: false,
        } as DataSourceQueryResult),
        getMetadata: jest.fn().mockResolvedValue({ name: sourceName, description: 'Test source' }),
        isAvailable: jest.fn().mockResolvedValue(true),
    });

    const createRegisteredPlugin = (
        plugin: IDataSourcePlugin,
        manifest: Partial<PluginManifest>,
        state: RegisteredPlugin['state'] = 'enabled',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test plugin',
            category: plugin.category,
            capabilities: manifest.capabilities || plugin.capabilities,
            systemPlugin: manifest.systemPlugin,
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataSourceFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest.fn().mockResolvedValue({}),
                    },
                },
                {
                    provide: DirectoryPluginRepository,
                    useValue: {
                        findByDirectoryAndPlugin: jest.fn().mockResolvedValue(null),
                        findActiveByCapability: jest.fn().mockResolvedValue(null),
                    },
                },
                {
                    provide: UserPluginRepository,
                    useValue: {
                        findByUserAndPlugin: jest.fn().mockResolvedValue(null),
                    },
                },
            ],
        }).compile();

        service = module.get<DataSourceFacadeService>(DataSourceFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
        directoryPluginRepository = module.get(DirectoryPluginRepository);
        userPluginRepository = module.get(UserPluginRepository);
    });

    describe('isConfigured', () => {
        it('should return true when data source plugin is enabled', () => {
            const dataSourcePlugin = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(dataSourcePlugin, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(true);
        });

        it('should return false when no data source plugins exist', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(service.isConfigured()).toBe(false);
        });

        it('should return false when data source plugin is not enabled', () => {
            const dataSourcePlugin = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(
                dataSourcePlugin,
                { capabilities: ['data-source'] },
                'loaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of available data source providers', () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(
                custom,
                { capabilities: ['data-source'] },
                'loaded',
            );

            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'apify-data-source',
                name: 'Apify Data Source',
                sourceName: 'Apify',
                enabled: true,
            });
            expect(providers[1]).toEqual({
                id: 'custom-data-source',
                name: 'Custom Data Source',
                sourceName: 'Custom',
                enabled: false,
            });
        });

        it('should return empty array when no providers exist', () => {
            registry.getByCapability.mockReturnValue([]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(0);
        });
    });

    describe('queryAll', () => {
        it('should skip plugins not enabled for directory', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { datasetId: 'abc123' },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should query plugins enabled via DirectoryPlugin', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [
                    { name: 'Item 1', description: 'Desc 1', source_url: 'https://example.com/1' },
                    { name: 'Item 2', description: 'Desc 2', source_url: 'https://example.com/2' },
                ],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                id: 'dp-1',
                directoryId: 'dir-123',
                pluginId: 'apify-data-source',
                enabled: true,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { datasetId: 'abc123' },
                },
            });

            expect(result.items).toHaveLength(2);
            expect(apify.query).toHaveBeenCalledWith(
                expect.objectContaining({
                    settings: expect.objectContaining({
                        datasetId: 'abc123',
                    }),
                }),
            );
        });

        it('should pass filterContext to plugins', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
                filterContext: {
                    prompt: 'AI tools for developers',
                    subject: 'AI',
                    keywords: ['AI', 'tools'],
                },
            });

            expect(apify.query).toHaveBeenCalledWith(
                expect.objectContaining({
                    filterContext: {
                        prompt: 'AI tools for developers',
                        subject: 'AI',
                        keywords: ['AI', 'tools'],
                    },
                }),
            );
        });

        it('should track items by source in sourceMap', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Apify Item', slug: 'apify-item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.sourceMap.get('apify-item')).toBe('apify-data-source');
        });

        it('should handle multiple data sources', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Apify Item', slug: 'apify-item', source_url: '' }],
                hasMore: false,
            });
            (custom.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Custom Item', slug: 'custom-item', source_url: '' }],
                hasMore: false,
            });

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(custom, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);

            const result = await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                    'custom-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(2);
            expect(result.sourceMap.get('apify-item')).toBe('apify-data-source');
            expect(result.sourceMap.get('custom-item')).toBe('custom-data-source');
        });

        it('should collect errors without failing other sources', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            (apify.query as jest.Mock).mockRejectedValue(new Error('Apify API error'));
            (custom.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Custom Item', slug: 'custom-item', source_url: '' }],
                hasMore: false,
            });

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(custom, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);

            const result = await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                    'custom-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].sourceId).toBe('apify-data-source');
            expect(result.errors[0].error).toBe('Apify API error');
        });

        it('should skip unavailable plugins', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.isAvailable as jest.Mock).mockResolvedValue(false);

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should merge resolved settings with pluginConfig', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // Admin-level API token
            settingsService.getSettings.mockResolvedValue({
                apiToken: 'admin-api-token',
            });

            await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true, datasetId: 'user-dataset' },
                },
            });

            expect(apify.query).toHaveBeenCalledWith(
                expect.objectContaining({
                    settings: {
                        apiToken: 'admin-api-token',
                        enabled: true,
                        datasetId: 'user-dataset',
                    },
                }),
            );
        });

        it('should collect categories, tags, and brands from sources', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
                categories: [{ id: 'cat1', name: 'Category 1' }],
                tags: [{ id: 'tag1', name: 'Tag 1' }],
                brands: [{ id: 'brand1', name: 'Brand 1' }],
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.queryAll({
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.categories).toEqual([{ id: 'cat1', name: 'Category 1' }]);
            expect(result.tags).toEqual([{ id: 'tag1', name: 'Tag 1' }]);
            expect(result.brands).toEqual([{ id: 'brand1', name: 'Brand 1' }]);
        });
    });

    describe('getEnabledSources', () => {
        it('should return sources enabled via DirectoryPlugin', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(custom, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);

            directoryPluginRepository.findByDirectoryAndPlugin
                .mockResolvedValueOnce({ enabled: true } as any) // apify
                .mockResolvedValueOnce({ enabled: false } as any); // custom

            const enabledSources = await service.getEnabledSources('dir-123');

            expect(enabledSources).toHaveLength(1);
            expect(enabledSources[0]).toEqual({
                id: 'apify-data-source',
                name: 'Apify Data Source',
                sourceName: 'Apify',
            });
        });

        it('should return empty array when no sources are enabled', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const enabledSources = await service.getEnabledSources('dir-123');

            expect(enabledSources).toHaveLength(0);
        });

        it('should return empty array when directoryId is empty', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const enabledSources = await service.getEnabledSources('');

            expect(enabledSources).toHaveLength(0);
        });
    });

    describe('three-level configuration', () => {
        it('should use DirectoryPlugin.enabled (Level 2) when record exists', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // DirectoryPlugin record exists with enabled=true
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                id: 'dp-1',
                directoryId: 'dir-123',
                pluginId: 'apify-data-source',
                pluginEntityId: 'pe-1',
                enabled: true,
                settings: {},
                secretSettings: {},
                metadata: {},
                priority: 0,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                // Note: pluginConfig.enabled is false, but Level 2 takes precedence
                pluginConfig: {
                    'apify-data-source': { enabled: false },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should respect DirectoryPlugin.enabled=false even with pluginConfig.enabled=true', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // DirectoryPlugin record exists with enabled=false
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                id: 'dp-1',
                directoryId: 'dir-123',
                pluginId: 'apify-data-source',
                pluginEntityId: 'pe-1',
                enabled: false,
                settings: {},
                secretSettings: {},
                metadata: {},
                priority: 0,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should fall back to pluginConfig.enabled (Level 3) when no DirectoryPlugin record', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // No DirectoryPlugin record
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should work without directoryId (uses Level 3 only)', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.queryAll({
                // No directoryId - can't check Level 2
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(directoryPluginRepository.findByDirectoryAndPlugin).not.toHaveBeenCalled();
        });

        it('should use autoEnable from manifest when no Level 2 or Level 3', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
                autoEnable: true, // Plugin auto-enables
            });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                // No pluginConfig.enabled
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should not autoEnable when manifest does not have autoEnable', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
                // No autoEnable
            });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should prioritize Level 2 over autoEnable', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
                autoEnable: true, // Plugin has autoEnable
            });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);

            // But DirectoryPlugin says disabled
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                id: 'dp-1',
                directoryId: 'dir-123',
                pluginId: 'apify-data-source',
                enabled: false,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should prioritize Level 2 over Level 3', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            // DirectoryPlugin says disabled
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                id: 'dp-1',
                directoryId: 'dir-123',
                pluginId: 'apify-data-source',
                enabled: false,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { enabled: true }, // Level 3 says enabled
                },
            });

            // Level 2 takes precedence, plugin should NOT be queried
            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should use Level 3 when no Level 2 record but no autoEnable', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
                // No autoEnable
            });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should not enable when no Level 2, no Level 3 enabled, and no autoEnable', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    'apify-data-source': { enabled: false },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should handle multiple plugins with different enable states', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Apify Item', slug: 'apify', source_url: '' }],
                hasMore: false,
            });
            (custom.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Custom Item', slug: 'custom', source_url: '' }],
                hasMore: false,
            });

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(custom, {
                capabilities: ['data-source'],
                autoEnable: true,
            });

            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);
            registry.get.mockImplementation((id) => {
                if (id === 'apify-data-source') return apifyRegistered;
                if (id === 'custom-data-source') return customRegistered;
                return undefined;
            });

            // Apify enabled via Level 2, Custom via autoEnable
            directoryPluginRepository.findByDirectoryAndPlugin
                .mockResolvedValueOnce({ enabled: true } as any) // apify
                .mockResolvedValueOnce(null); // custom - will use autoEnable

            const result = await service.queryAll({
                directoryId: 'dir-123',
            });

            expect(result.items).toHaveLength(2);
            expect(apify.query).toHaveBeenCalled();
            expect(custom.query).toHaveBeenCalled();
        });
    });

    describe('Level 1 (UserPlugin) enable check', () => {
        it('should use UserPlugin.enabled when no DirectoryPlugin record exists', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);

            // No DirectoryPlugin record
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            // UserPlugin says enabled
            userPluginRepository.findByUserAndPlugin.mockResolvedValue({
                enabled: true,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                userId: 'user-456',
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should respect UserPlugin.enabled=false when no DirectoryPlugin record', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);

            // No DirectoryPlugin record
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            // UserPlugin says disabled
            userPluginRepository.findByUserAndPlugin.mockResolvedValue({
                enabled: false,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                userId: 'user-456',
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should prioritize DirectoryPlugin.enabled over UserPlugin.enabled', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // DirectoryPlugin says enabled
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                enabled: true,
            } as any);
            // UserPlugin says disabled (should be ignored)
            userPluginRepository.findByUserAndPlugin.mockResolvedValue({
                enabled: false,
            } as any);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                userId: 'user-456',
            });

            // Directory level takes precedence
            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should fall back to autoEnable when no User or Directory records', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
                autoEnable: true,
            });
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);

            // No DirectoryPlugin record
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            // No UserPlugin record
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                userId: 'user-456',
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });
    });

    describe('getDefaultProvider', () => {
        it('should return default provider from activeCapability', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.get.mockReturnValue(registered);

            // DirectoryPlugin has activeCapability set
            directoryPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'apify-data-source',
            } as any);

            const result = await service.getDefaultProvider('data-source', 'dir-123');

            expect(result).toEqual({
                id: 'apify-data-source',
                name: 'Apify Data Source',
            });
        });

        it('should fall back to first enabled plugin when no activeCapability', async () => {
            const apify = createMockDataSourcePlugin('apify-data-source', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // No activeCapability set
            directoryPluginRepository.findActiveByCapability.mockResolvedValue(null);

            const result = await service.getDefaultProvider('data-source', 'dir-123');

            expect(result).toEqual({
                id: 'apify-data-source',
                name: 'Apify Data Source',
            });
        });

        it('should return null when no providers exist', async () => {
            registry.getByCapability.mockReturnValue([]);
            directoryPluginRepository.findActiveByCapability.mockResolvedValue(null);

            const result = await service.getDefaultProvider('data-source', 'dir-123');

            expect(result).toBeNull();
        });
    });
});

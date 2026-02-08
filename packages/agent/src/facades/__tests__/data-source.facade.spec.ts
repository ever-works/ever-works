import { Test, TestingModule } from '@nestjs/testing';
import { DataSourceFacadeService, DataSourceFacadeError } from '../data-source.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
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

    const createMockDataSourcePlugin = (id: string, sourceName: string): IDataSourcePlugin => ({
        id,
        name: `${sourceName}`,
        version: '1.0.0',
        category: 'data-source',
        capabilities: ['data-source'],
        settingsSchema: { type: 'object', properties: {} },
        sourceName,
        onLoad: jest.fn(),
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
        state: RegisteredPlugin['state'] = 'loaded',
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
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                        getDefaultForCapabilityScoped: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest.fn().mockResolvedValue({}),
                    },
                },
            ],
        }).compile();

        service = module.get<DataSourceFacadeService>(DataSourceFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('isConfigured', () => {
        it('should return true when data source plugin is enabled', () => {
            const dataSourcePlugin = createMockDataSourcePlugin('apify', 'Apify');
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
            const dataSourcePlugin = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(
                dataSourcePlugin,
                { capabilities: ['data-source'] },
                'unloaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of available data source providers', () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(
                custom,
                { capabilities: ['data-source'] },
                'unloaded',
            );

            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'apify',
                name: 'Apify',
                sourceName: 'Apify',
                enabled: true,
            });
            expect(providers[1]).toEqual({
                id: 'custom-data-source',
                name: 'Custom',
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
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    apify: { datasetId: 'abc123' },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should query plugins enabled via registry scope check', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [
                    { name: 'Item 1', description: 'Desc 1', source_url: 'https://example.com/1' },
                    { name: 'Item 2', description: 'Desc 2', source_url: 'https://example.com/2' },
                ],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    apify: { datasetId: 'abc123' },
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
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            await service.queryAll({
                pluginConfig: {
                    apify: { enabled: true },
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
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Apify Item', slug: 'apify-item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.queryAll({
                pluginConfig: {
                    apify: { enabled: true },
                },
            });

            expect(result.sourceMap.get('apify-item')).toBe('apify');
        });

        it('should handle multiple data sources', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
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
                    apify: { enabled: true },
                    'custom-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(2);
            expect(result.sourceMap.get('apify-item')).toBe('apify');
            expect(result.sourceMap.get('custom-item')).toBe('custom-data-source');
        });

        it('should collect errors without failing other sources', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
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
                    apify: { enabled: true },
                    'custom-data-source': { enabled: true },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].sourceId).toBe('apify');
            expect(result.errors[0].error).toBe('Apify API error');
        });

        it('should skip unavailable plugins', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            (apify.isAvailable as jest.Mock).mockResolvedValue(false);

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.queryAll({
                pluginConfig: {
                    apify: { enabled: true },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should merge resolved settings with pluginConfig', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            // Admin-level API token
            settingsService.getSettings.mockResolvedValue({
                apiToken: 'admin-api-token',
            });

            await service.queryAll({
                pluginConfig: {
                    apify: { enabled: true, datasetId: 'user-dataset' },
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
            const apify = createMockDataSourcePlugin('apify', 'Apify');
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
                    apify: { enabled: true },
                },
            });

            expect(result.categories).toEqual([{ id: 'cat1', name: 'Category 1' }]);
            expect(result.tags).toEqual([{ id: 'tag1', name: 'Tag 1' }]);
            expect(result.brands).toEqual([{ id: 'brand1', name: 'Brand 1' }]);
        });
    });

    describe('getEnabledSources', () => {
        it('should return sources enabled via registry scope check', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const custom = createMockDataSourcePlugin('custom-data-source', 'Custom');

            const apifyRegistered = createRegisteredPlugin(apify, {
                capabilities: ['data-source'],
            });
            const customRegistered = createRegisteredPlugin(custom, {
                capabilities: ['data-source'],
            });
            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);

            registry.isPluginEnabledForScope
                .mockResolvedValueOnce(true) // apify
                .mockResolvedValueOnce(false); // custom

            const enabledSources = await service.getEnabledSources('dir-123');

            expect(enabledSources).toHaveLength(1);
            expect(enabledSources[0]).toEqual({
                id: 'apify',
                name: 'Apify',
                sourceName: 'Apify',
            });
        });

        it('should return empty array when no sources are enabled', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            const enabledSources = await service.getEnabledSources('dir-123');

            expect(enabledSources).toHaveLength(0);
        });

        it('should return empty array when directoryId is empty', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);

            const enabledSources = await service.getEnabledSources('');

            expect(enabledSources).toHaveLength(0);
        });
    });

    describe('enable check via registry', () => {
        it('should enable plugin when registry scope check returns true', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const result = await service.queryAll({
                directoryId: 'dir-123',
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'apify',
                'dir-123',
                undefined,
            );
        });

        it('should disable plugin when registry scope check returns false', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            const result = await service.queryAll({
                directoryId: 'dir-123',
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should enable via pluginConfig.enabled even when registry returns false', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    apify: { enabled: true },
                },
            });

            expect(result.items).toHaveLength(1);
            expect(apify.query).toHaveBeenCalled();
        });

        it('should not enable when pluginConfig.enabled is false and registry returns false', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            const result = await service.queryAll({
                directoryId: 'dir-123',
                pluginConfig: {
                    apify: { enabled: false },
                },
            });

            expect(result.items).toHaveLength(0);
            expect(apify.query).not.toHaveBeenCalled();
        });

        it('should pass directoryId and userId to registry scope check', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            (apify.query as jest.Mock).mockResolvedValue({
                items: [{ name: 'Item', slug: 'item', source_url: '' }],
                hasMore: false,
            });

            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            await service.queryAll({
                directoryId: 'dir-123',
                userId: 'user-456',
            });

            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'apify',
                'dir-123',
                'user-456',
            );
        });

        it('should handle multiple plugins with different enable states', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
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
            });

            registry.getByCapability.mockReturnValue([apifyRegistered, customRegistered]);
            registry.isPluginEnabledForScope
                .mockResolvedValueOnce(true) // apify enabled
                .mockResolvedValueOnce(true); // custom enabled

            const result = await service.queryAll({
                directoryId: 'dir-123',
            });

            expect(result.items).toHaveLength(2);
            expect(apify.query).toHaveBeenCalled();
            expect(custom.query).toHaveBeenCalled();
        });
    });

    describe('getDefaultProvider', () => {
        it('should return default provider from registry scoped resolution', async () => {
            const apify = createMockDataSourcePlugin('apify', 'Apify');
            const registered = createRegisteredPlugin(apify, { capabilities: ['data-source'] });
            registry.getDefaultForCapabilityScoped.mockResolvedValue(registered);

            const result = await service.getDefaultProvider('data-source', 'dir-123', 'user-123');

            expect(result).toEqual({
                id: 'apify',
                name: 'Apify',
            });
            expect(registry.getDefaultForCapabilityScoped).toHaveBeenCalledWith(
                'data-source',
                'dir-123',
                'user-123',
            );
        });

        it('should return null when no providers exist', async () => {
            registry.getDefaultForCapabilityScoped.mockResolvedValue(undefined);

            const result = await service.getDefaultProvider('data-source', 'dir-123');

            expect(result).toBeNull();
        });
    });
});

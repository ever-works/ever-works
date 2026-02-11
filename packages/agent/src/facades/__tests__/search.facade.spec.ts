import { Test, TestingModule } from '@nestjs/testing';
import { SearchFacadeService } from '../search.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { ISearchPlugin, PluginManifest } from '@ever-works/plugin';

describe('SearchFacadeService', () => {
    let service: SearchFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const createMockSearchPlugin = (id: string, providerName: string): ISearchPlugin => ({
        id,
        name: `${providerName} Plugin`,
        version: '1.0.0',
        category: 'search',
        capabilities: ['search'],
        settingsSchema: { type: 'object', properties: {} },
        configurationMode: 'hybrid',
        providerName,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        search: jest.fn().mockResolvedValue({ results: [], query: '', totalResults: 0 }),
        isAvailable: jest.fn().mockResolvedValue(true),
        getRateLimitInfo: jest.fn().mockResolvedValue({ remaining: -1, limit: -1 }),
    });

    const createRegisteredPlugin = (
        plugin: ISearchPlugin,
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
                SearchFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
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

        service = module.get<SearchFacadeService>(SearchFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('isConfigured', () => {
        it('should return true when search plugin is enabled', () => {
            const searchPlugin = createMockSearchPlugin('tavily', 'Tavily');
            const registered = createRegisteredPlugin(searchPlugin, {
                capabilities: ['search'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(true);
        });

        it('should return false when no search plugins exist', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(service.isConfigured()).toBe(false);
        });

        it('should return false when search plugin is not enabled', () => {
            const searchPlugin = createMockSearchPlugin('tavily', 'Tavily');
            const registered = createRegisteredPlugin(
                searchPlugin,
                { capabilities: ['search'] },
                'unloaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of available search providers', () => {
            const tavily = createMockSearchPlugin('tavily', 'Tavily');
            const exa = createMockSearchPlugin('exa-search', 'Exa');

            const tavilyRegistered = createRegisteredPlugin(tavily, {
                capabilities: ['search'],
            });
            const exaRegistered = createRegisteredPlugin(
                exa,
                { capabilities: ['search'] },
                'unloaded',
            );

            registry.getByCapability.mockReturnValue([tavilyRegistered, exaRegistered]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'tavily',
                name: 'Tavily',
                enabled: true,
            });
            expect(providers[1]).toEqual({
                id: 'exa-search',
                name: 'Exa',
                enabled: false,
            });
        });
    });
});

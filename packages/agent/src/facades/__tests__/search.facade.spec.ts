import { Test, TestingModule } from '@nestjs/testing';
import { SearchFacadeService } from '../search.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { ISearchPlugin, PluginManifest } from '@ever-works/plugin';
import { PluginUsageService } from '../../usage/plugin-usage.service';
import { PublishedCreditPriceList } from '../../usage/credit-price-list';
import { UsageMeter, UsageOutcome, UsagePayer } from '@src/entities/_types';

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

    /**
     * AW-17 — a search is recorded whether it succeeds or fails, carries the
     * Mission of the run's Task, and a failed search costs 0 credits.
     */
    describe('search — usage outcome and Mission attribution (AW-17)', () => {
        const facadeOptions = {
            userId: 'user-1',
            workId: 'work-1',
            agentId: 'agent-1',
            taskId: 'task-1',
            runId: 'run-1',
            missionId: 'mission-1',
        };

        function build(
            plugin: ISearchPlugin,
            usageRepo = { record: jest.fn().mockResolvedValue({ id: 'e' }) },
        ) {
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['search'] }),
            ]);
            const usage = new PluginUsageService(
                usageRepo as never,
                new PublishedCreditPriceList(),
                {
                    resolve: jest.fn().mockResolvedValue(UsagePayer.PLATFORM),
                },
            );
            const facade = new SearchFacadeService(registry, settingsService, undefined, usage);
            return { facade, usageRepo };
        }

        it('records a successful search at the published price, with the Mission of the Task', async () => {
            const plugin = createMockSearchPlugin('search-a', 'Search A');
            const { facade, usageRepo } = build(plugin);

            await facade.search('ever works', undefined, facadeOptions);

            expect(usageRepo.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    pluginId: 'search-a',
                    runId: 'run-1',
                    missionId: 'mission-1',
                    meter: UsageMeter.CREDITS,
                    outcome: UsageOutcome.OK,
                    priceKey: 'search.query',
                    creditsCharged: 2,
                }),
            );
        });

        it('records a failing provider call as failed at 0 credits, then rethrows', async () => {
            const plugin = createMockSearchPlugin('search-a', 'Search A');
            (plugin.search as jest.Mock).mockRejectedValue(new Error('upstream 500 key=sk-secret'));
            const { facade, usageRepo } = build(plugin);

            await expect(facade.search('ever works', undefined, facadeOptions)).rejects.toThrow(
                'upstream 500',
            );

            expect(usageRepo.record).toHaveBeenCalledTimes(1);
            const row = usageRepo.record.mock.calls[0][0];
            expect(row).toMatchObject({
                outcome: UsageOutcome.FAILED,
                creditsCharged: 0,
                costCents: 0,
                missionId: 'mission-1',
            });
            // The provider's message never reaches the usage row.
            expect(JSON.stringify(row)).not.toContain('sk-secret');
        });

        it('still rethrows the provider error when usage recording is not wired', async () => {
            const plugin = createMockSearchPlugin('search-a', 'Search A');
            (plugin.search as jest.Mock).mockRejectedValue(new Error('rate limited'));
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(plugin, { capabilities: ['search'] }),
            ]);

            await expect(service.search('q', undefined, facadeOptions)).rejects.toThrow(
                'rate limited',
            );
        });
    });
});

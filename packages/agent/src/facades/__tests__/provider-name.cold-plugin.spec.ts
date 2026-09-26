import { Logger } from '@nestjs/common';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { JsonSchema } from '@ever-works/plugin';
import { BaseFacadeService } from '../base.facade';
import { ContentExtractorFacadeService } from '../content-extractor.facade';
import { DataSourceFacadeService } from '../data-source.facade';
import { DeployFacadeService, NoDeployCredentialsError } from '../deploy.facade';
import { GitFacadeService } from '../git.facade';
import { ModelProviderCatalogService } from '../../model-routing/model-provider-catalog.service';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    type ColdPlugin,
    createRegistry,
    registerColdPlugin,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * task_f6ae037f — provider names read off a lazy plugin proxy.
 *
 * `providerName` / `sourceName` are data members of the plugin CLASS; the
 * package.json manifest does not carry them. Before the fix the proxy
 * answered them with its async forwarding wrapper — a function — even once
 * the plugin had loaded, so a loaded provider's name came back as a function.
 * A reader that cannot await a load (a sync provider listing, an error
 * message) still meets a COLD proxy, whose read cannot answer the class value
 * — it must fall back to the manifest name rather than hand the wrapper on.
 */

const EMPTY_SCHEMA = { type: 'object', properties: {} } as JsonSchema;

function coldProvider(
    registry: PluginRegistryService,
    id: string,
    capability: string,
    members: Record<string, unknown>,
): ColdPlugin {
    return registerColdPlugin(registry, {
        id,
        category: capability,
        capabilities: [capability],
        settingsSchema: EMPTY_SCHEMA,
        manifest: { autoEnable: true },
        members,
    });
}

describe('provider names over lazy plugins — BaseFacadeService', () => {
    const CAPABILITY = 'cold-named-capability';

    class NamedFacade extends BaseFacadeService {
        protected readonly CAPABILITY = CAPABILITY;
        protected readonly logger = new Logger('NamedFacade');
    }

    function build() {
        const registry = createRegistry();
        const facade = new NamedFacade(registry, undefined);
        const cold = coldProvider(registry, 'cold-named', CAPABILITY, {
            providerName: 'Cold Named Provider',
        });
        return { registry, facade, cold };
    }

    it("answers a loaded provider's own providerName in the user-scoped listing", async () => {
        const { facade } = build();

        const [provider] = await facade.getAvailableProvidersForUser('user-1');

        expect(provider.providerName).toBe('Cold Named Provider');
    });

    it("answers a loaded provider's own providerName as the default provider's name", async () => {
        const { facade } = build();

        await expect(facade.getDefaultProvider(undefined, 'user-1')).resolves.toEqual({
            id: 'cold-named',
            name: 'Cold Named Provider',
        });
    });

    it('names a still-cold provider by its manifest name in the sync listing, without loading it', () => {
        const { facade, cold } = build();

        expect(facade.getAvailableProviders()).toEqual([
            { id: 'cold-named', name: 'Plugin cold-named', enabled: true },
        ]);
        expect(cold.loads()).toBe(0);
    });

    it('names a provider by its own providerName in the sync listing once it has loaded', async () => {
        const { facade, cold } = build();
        await cold.proxy.__materialize();

        expect(facade.getAvailableProviders()).toEqual([
            { id: 'cold-named', name: 'Cold Named Provider', enabled: true },
        ]);
    });
});

describe('provider names over lazy plugins — sync provider listings', () => {
    it('ContentExtractorFacadeService.getAvailableProviders names a cold extractor by its manifest name', async () => {
        const registry = createRegistry();
        const cold = coldProvider(
            registry,
            'cold-extractor',
            PLUGIN_CAPABILITIES.CONTENT_EXTRACTOR,
            {
                providerName: 'Cold Extractor',
            },
        );
        const facade = new ContentExtractorFacadeService(registry, {} as PluginSettingsService);

        expect(facade.getAvailableProviders()).toEqual([
            { id: 'cold-extractor', name: 'Plugin cold-extractor', enabled: true },
        ]);
        expect(cold.loads()).toBe(0);

        await cold.proxy.__materialize();
        expect(facade.getAvailableProviders()[0].name).toBe('Cold Extractor');
    });

    it('GitFacadeService.getAvailableProviders names a cold git provider by its manifest name', async () => {
        const registry = createRegistry();
        const cold = coldProvider(registry, 'cold-git', PLUGIN_CAPABILITIES.GIT_PROVIDER, {
            providerName: 'Cold Git',
        });
        const facade = new GitFacadeService(
            registry,
            ...([{}, {}, {}, {}] as unknown as [never, never, never, never]),
        );

        expect(facade.getAvailableProviders()).toEqual([
            expect.objectContaining({ id: 'cold-git', name: 'Plugin cold-git', enabled: true }),
        ]);
        expect(cold.loads()).toBe(0);

        await cold.proxy.__materialize();
        expect(facade.getAvailableProviders()[0].name).toBe('Cold Git');
    });

    it('DataSourceFacadeService.getAvailableProviders answers a string sourceName for a cold data source', async () => {
        const registry = createRegistry();
        const cold = coldProvider(registry, 'cold-source', PLUGIN_CAPABILITIES.DATA_SOURCE, {
            sourceName: 'Cold Source',
        });
        const facade = new DataSourceFacadeService(registry, {} as PluginSettingsService);

        expect(facade.getAvailableProviders()).toEqual([
            {
                id: 'cold-source',
                name: 'Plugin cold-source',
                sourceName: 'Plugin cold-source',
                enabled: true,
            },
        ]);
        expect(cold.loads()).toBe(0);

        await cold.proxy.__materialize();
        expect(facade.getAvailableProviders()[0].sourceName).toBe('Cold Source');
    });

    it('DataSourceFacadeService.getEnabledSources answers a string sourceName for a cold data source', async () => {
        const registry = createRegistry();
        const cold = coldProvider(registry, 'cold-source', PLUGIN_CAPABILITIES.DATA_SOURCE, {
            sourceName: 'Cold Source',
        });
        const facade = new DataSourceFacadeService(registry, {} as PluginSettingsService);

        await expect(facade.getEnabledSources('work-1', 'user-1')).resolves.toEqual([
            { id: 'cold-source', name: 'Plugin cold-source', sourceName: 'Plugin cold-source' },
        ]);
        expect(cold.loads()).toBe(0);

        await cold.proxy.__materialize();
        await expect(facade.getEnabledSources('work-1', 'user-1')).resolves.toEqual([
            { id: 'cold-source', name: 'Plugin cold-source', sourceName: 'Cold Source' },
        ]);
    });

    it('ModelProviderCatalogService.providerName names a cold AI provider by its manifest name', async () => {
        const registry = createRegistry();
        const cold = coldProvider(registry, 'cold-ai', PLUGIN_CAPABILITIES.AI_PROVIDER, {
            providerName: 'Cold AI',
        });
        const catalog = new ModelProviderCatalogService(registry);

        expect(catalog.providerName('cold-ai')).toBe('Plugin cold-ai');
        expect(cold.loads()).toBe(0);

        await cold.proxy.__materialize();
        expect(catalog.providerName('cold-ai')).toBe('Cold AI');
    });
});

describe('provider names over lazy plugins — DeployFacadeService credentials error', () => {
    it('names a cold deploy provider by its manifest name when its credentials are missing', async () => {
        const registry = createRegistry();
        coldProvider(registry, 'cold-deploy', PLUGIN_CAPABILITIES.DEPLOYMENT, {
            providerName: 'Cold Deploy',
        });
        const settingsService = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as PluginSettingsService;
        const workRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'work-1', deployProvider: 'cold-deploy' }),
        };
        const facade = new DeployFacadeService(
            registry,
            settingsService,
            ...([workRepository, {}, {}] as unknown as [never, never, never]),
        );

        const failure = await facade.getTeams({ workId: 'work-1', userId: 'user-1' }).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(NoDeployCredentialsError);
        expect((failure as Error).message).toBe(
            'No Plugin cold-deploy credentials configured. ' +
                'Please configure your Plugin cold-deploy token in Plugin Settings.',
        );
    });
});

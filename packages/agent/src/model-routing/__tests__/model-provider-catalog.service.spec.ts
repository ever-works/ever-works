import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { ModelProviderCatalogService } from '../model-provider-catalog.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

/**
 * Model accounts (AW-16) — the provider catalogue. A supplementary AI
 * provider is never offered in the provider list; `getProvider` still
 * resolves it (routing and health checks work from ids already stored) but
 * says it is supplementary, so the account service can refuse to add one.
 */
describe('ModelProviderCatalogService', () => {
    function registered(id: string, supplementary?: boolean): RegisteredPlugin {
        return {
            plugin: {
                id,
                providerName: `Provider ${id}`,
                settingsSchema: {
                    type: 'object',
                    properties: { apiKey: { type: 'string', 'x-secret': true } },
                },
            },
            manifest: {
                id,
                name: id,
                capabilities: ['ai-provider'],
                ...(supplementary === undefined ? {} : { supplementary }),
            },
            state: 'loaded',
        } as unknown as RegisteredPlugin;
    }

    const table: Record<string, RegisteredPlugin> = {
        'provider-a': registered('provider-a'),
        'helper-provider': registered('helper-provider', true),
    };
    const catalog = new ModelProviderCatalogService({
        get: (id: string) => table[id],
        getByCapability: () => Object.values(table),
    } as unknown as PluginRegistryService);

    it('leaves a supplementary provider out of the list', async () => {
        const listed = await catalog.listProviders();
        expect(listed.map((provider) => provider.providerPluginId)).toEqual(['provider-a']);
        expect(listed[0].supplementary).toBeUndefined();
    });

    it('still resolves a supplementary provider by id, flagged as supplementary', async () => {
        await expect(catalog.getProvider('helper-provider')).resolves.toMatchObject({
            providerPluginId: 'helper-provider',
            supplementary: true,
        });
        const regular = await catalog.getProvider('provider-a');
        expect(regular?.supplementary).toBeUndefined();
    });
});

/**
 * The same catalogue over AI providers the registry still holds as COLD lazy
 * proxies (a real registry, real proxies): the first read loads them.
 */
describe('ModelProviderCatalogService — cold providers', () => {
    const AI = 'ai-provider';

    /**
     * F4 — `supplementary` can come from the class's getManifest() alone
     * (pdf-extractor, officecli-extractor, notion-extractor declare it there);
     * a cold entry carries the package.json manifest only, so the flag is read
     * after the load.
     */
    it('leaves out a provider whose getManifest() marks it supplementary, and flags it by id', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, {
            id: 'cold-regular',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-supplementary',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { supplementary: true },
        });
        const catalog = new ModelProviderCatalogService(registry);

        const listed = await catalog.listProviders();

        expect(listed.map((provider) => provider.providerPluginId)).toEqual(['cold-regular']);
        await expect(catalog.getProvider('cold-supplementary')).resolves.toMatchObject({
            providerPluginId: 'cold-supplementary',
            supplementary: true,
        });
    });

    /**
     * F6 — a provider whose `onLoad` fails on this first use is not offered:
     * the load resolves, but the entry turns `error` (the eager boot skipped
     * such a plugin at boot).
     */
    it('does not offer a provider whose onLoad fails on first use', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, {
            id: 'cold-healthy',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-onload-fails',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
        });
        const catalog = new ModelProviderCatalogService(registry);

        const listed = await catalog.listProviders();

        expect(listed.map((provider) => provider.providerPluginId)).toEqual(['cold-healthy']);
        expect(listed[0].credentialFields.map((field) => field.key)).toEqual(['apiKey']);
        expect(registry.get('cold-onload-fails')?.state).toBe('error');
        await expect(catalog.getProvider('cold-onload-fails')).resolves.toBeNull();
    });
});

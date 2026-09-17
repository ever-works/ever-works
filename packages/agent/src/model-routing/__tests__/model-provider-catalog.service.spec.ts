import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { ModelProviderCatalogService } from '../model-provider-catalog.service';

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

jest.mock('@ever-works/agent/facades', () => ({
    SearchFacadeService: class {},
    NoProviderError: class NoProviderError extends Error {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { IPlugin, JsonSchema, PluginManifest } from '@ever-works/plugin';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import type { PluginSettingsService } from '@ever-works/agent/plugins';
import type { SearchFacadeService } from '@ever-works/agent/facades';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { SearchController } from './search.controller';

const REQUIRED_API_KEY: JsonSchema = {
    type: 'object',
    properties: { apiKey: { type: 'string', 'x-secret': true } },
    required: ['apiKey'],
} as unknown as JsonSchema;

/**
 * Search availability over a provider the registry holds as a COLD lazy
 * proxy — the shape of every plugin discovered on disk until something
 * materialises it (a REAL `PluginRegistryService.registerLazy`, no mocks in
 * between). The provider requires an API key nobody configured: while cold
 * its proxy answers `{}` for the schema, which must not make it look ready.
 */
describe('SearchController — cold lazy search provider', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;

    function build(settings: Record<string, unknown>) {
        const registry = new PluginRegistryService(new EventEmitter2());
        registry.registerLazy(
            {
                id: 'cold-search',
                name: 'Cold Search',
                version: '1.0.0',
                description: 'cold fixture',
                category: 'search',
                capabilities: [PLUGIN_CAPABILITIES.SEARCH],
                autoEnable: true,
            } as PluginManifest,
            async () =>
                ({
                    id: 'cold-search',
                    name: 'Cold Search',
                    version: '1.0.0',
                    category: 'search',
                    capabilities: [PLUGIN_CAPABILITIES.SEARCH],
                    settingsSchema: REQUIRED_API_KEY,
                    onLoad: async () => undefined,
                    onUnload: async () => undefined,
                }) as unknown as IPlugin,
        );
        const pluginSettings = { getSettings: jest.fn().mockResolvedValue(settings) };
        const controller = new SearchController(
            {} as SearchFacadeService,
            registry,
            pluginSettings as unknown as PluginSettingsService,
            {} as WorkOwnershipService,
        );
        return controller;
    }

    it('reports search unavailable while the cold provider has no API key', async () => {
        const result = await build({}).checkAvailability(auth);

        expect(result.available).toBe(false);
        expect(result.activeProvider).toBeNull();
    });

    it('reports the cold provider available once its API key is configured', async () => {
        const result = await build({ apiKey: 'sk-search' }).checkAvailability(auth);

        expect(result.available).toBe(true);
        expect(result.activeProvider).toEqual({ id: 'cold-search', name: 'Cold Search' });
    });
});

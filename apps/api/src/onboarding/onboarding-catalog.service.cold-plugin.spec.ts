import { EventEmitter2 } from '@nestjs/event-emitter';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { OnboardingCatalogService } from './onboarding-catalog.service';

/**
 * The "Plugins & Integrations" step lists the plugins whose manifest opts
 * into onboarding (`uiHints.includeInOnboarding`). Every plugin that does so
 * today — zapier, make, composio, activepieces, sim-ai, … — declares
 * `uiHints` only in its class's getManifest(), never in package.json.
 *
 * The registry holds those plugins as lazy proxies (a REAL
 * `PluginRegistryService.registerLazy`) until something uses them, and a cold
 * entry carries the package.json manifest alone: the catalog must load the
 * plugins before reading their `uiHints`.
 */
describe('OnboardingCatalogService — plugins the registry still holds cold', () => {
    function registerCold(
        registry: PluginRegistryService,
        id: string,
        uiHints: Record<string, unknown> | undefined,
        options: { failing?: boolean } = {},
    ) {
        const manifest = {
            id,
            name: `Plugin ${id}`,
            version: '1.0.0',
            description: `${id} description`,
            category: 'pipeline',
            capabilities: ['pipeline'],
        } as PluginManifest;
        const runtimeManifest = { ...manifest, ...(uiHints ? { uiHints } : {}) };
        registry.registerLazy(
            manifest,
            async () => {
                if (options.failing) throw new Error(`cannot import ${id}`);
                return {
                    ...manifest,
                    settingsSchema: {},
                    getManifest: () => runtimeManifest,
                    onLoad: async () => undefined,
                    onUnload: async () => undefined,
                } as unknown as IPlugin;
            },
            {
                // What PluginLoaderService.enrichManifestAfterMaterialize does
                // on first materialise (package.json fields win).
                onFirstMaterialize: async (pluginId, real) => {
                    registry.updateRegisteredManifest(pluginId, {
                        ...real.getManifest!(),
                        ...manifest,
                    });
                },
                onMaterializeError: async (pluginId, error) => {
                    registry.updateState(pluginId, 'error', error);
                },
            },
        );
    }

    it('lists the cold plugins whose getManifest() opts into onboarding, by priority', async () => {
        const registry = new PluginRegistryService(new EventEmitter2());
        registerCold(registry, 'cold-zapier', { includeInOnboarding: true, onboardingPriority: 2 });
        registerCold(registry, 'cold-hidden-from-onboarding', { includeInOnboarding: false });
        registerCold(registry, 'cold-no-hints', undefined);
        registerCold(registry, 'cold-make', { includeInOnboarding: true, onboardingPriority: 1 });
        registerCold(registry, 'cold-broken', { includeInOnboarding: true }, { failing: true });

        const catalog = await new OnboardingCatalogService(registry).getCatalog();

        expect(catalog.plugins).toEqual([
            {
                pluginId: 'cold-make',
                name: 'Plugin cold-make',
                category: 'pipeline',
                description: 'cold-make description',
                onboardingPriority: 1,
            },
            {
                pluginId: 'cold-zapier',
                name: 'Plugin cold-zapier',
                category: 'pipeline',
                description: 'cold-zapier description',
                onboardingPriority: 2,
            },
        ]);
    });

    it('does not load a plugin an earlier wizard step already reserves', async () => {
        const registry = new PluginRegistryService(new EventEmitter2());
        registerCold(registry, 'slack-connector', { includeInOnboarding: true });

        const catalog = await new OnboardingCatalogService(registry).getCatalog();

        expect(catalog.plugins).toEqual([]);
        const proxy = registry.get('slack-connector')?.plugin as { __isMaterialized?: boolean };
        expect(proxy.__isMaterialized).toBe(false);
    });
});

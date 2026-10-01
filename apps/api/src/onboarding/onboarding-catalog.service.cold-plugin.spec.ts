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
 *
 * Every one of them is a builtIn (package.json `builtIn: true`), loaded at
 * boot before lazy builtIns (60916d328). The catalog loads only builtIns — a
 * cold plugin that is not one stays cold and is not offered, as before — and
 * a bounded number at a time.
 */
describe('OnboardingCatalogService — plugins the registry still holds cold', () => {
    function registerCold(
        registry: PluginRegistryService,
        id: string,
        uiHints: Record<string, unknown> | undefined,
        options: { failing?: boolean; builtIn?: boolean; onImport?: () => Promise<void> } = {},
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
        let imports = 0;
        registry.registerLazy(
            manifest,
            async () => {
                imports += 1;
                await options.onImport?.();
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
                // Pin changed (F7, second review of 60916d328): registered as a
                // builtIn unless a case says otherwise — the real plugins are.
                builtIn: options.builtIn ?? true,
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
        return { imports: () => imports };
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

    it('does not import a cold plugin that is not builtIn, and does not offer it', async () => {
        const registry = new PluginRegistryService(new EventEmitter2());
        registerCold(registry, 'cold-builtin-zapier', { includeInOnboarding: true });
        const thirdParty = registerCold(
            registry,
            'cold-third-party',
            { includeInOnboarding: true },
            { builtIn: false },
        );

        const catalog = await new OnboardingCatalogService(registry).getCatalog();

        expect(catalog.plugins.map((card) => card.pluginId)).toEqual(['cold-builtin-zapier']);
        expect(thirdParty.imports()).toBe(0);
    });

    it('loads at most 6 cold plugins at a time', async () => {
        const registry = new PluginRegistryService(new EventEmitter2());
        let active = 0;
        let peak = 0;
        const onImport = async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setImmediate(resolve));
            active -= 1;
        };
        for (let index = 0; index < 15; index += 1) {
            registerCold(
                registry,
                `cold-bounded-${index}`,
                { includeInOnboarding: true },
                {
                    onImport,
                },
            );
        }

        const catalog = await new OnboardingCatalogService(registry).getCatalog();

        expect(catalog.plugins).toHaveLength(15);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(6);
    });
});

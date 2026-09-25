import { Logger } from '@nestjs/common';
import type { IPlugin } from '@ever-works/plugin';
import { BaseFacadeService, ProviderNotFoundError } from '../base.facade';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import {
    type ColdPluginSpec,
    type Pingable,
    createRegistry,
    gate,
    registerColdPlugin,
    requiredSecretSchema,
    settle,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const CAPABILITY = 'cold-capability';

class ColdFacade extends BaseFacadeService {
    protected readonly CAPABILITY = CAPABILITY;
    protected readonly logger = new Logger('ColdFacade');

    resolve(providerOverride?: string, userId?: string, workId?: string): Promise<IPlugin> {
        return this.resolvePlugin<IPlugin>(providerOverride, userId, workId);
    }

    activeForWork(workId: string) {
        return this.findActivePluginForWork(workId);
    }
}

/**
 * Provider selection in `BaseFacadeService` — the hub every capability facade
 * (AI, search, screenshot, deploy, …) resolves its plugin through — over
 * plugins the registry still holds as COLD lazy proxies.
 *
 * Several builtIns declare selection fields only in their class's
 * getManifest() (openrouter is the default AI provider that way; the
 * pipelines' `selectableProviderCategories`, pdf-extractor's `supplementary`),
 * and whether a plugin's import or onLoad fails is only known once it loads.
 * The cold registry entry carries neither.
 */
describe('BaseFacadeService — provider selection over cold lazy plugins', () => {
    function plugin(id: string, extra: Partial<ColdPluginSpec> = {}): ColdPluginSpec {
        return {
            id,
            capabilities: [CAPABILITY],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            ...extra,
        };
    }

    function build(activePluginId?: string) {
        const registry = createRegistry();
        const workPluginRepository = {
            findActiveByCapability: jest
                .fn()
                .mockResolvedValue(activePluginId ? { pluginId: activePluginId } : null),
        } as unknown as WorkPluginRepository;
        const facade = new ColdFacade(
            registry as PluginRegistryService,
            undefined,
            workPluginRepository,
        );
        return { registry, facade };
    }

    it('resolves the plugin whose getManifest() declares it the default', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, plugin('cold-other'));
        registerColdPlugin(
            registry,
            plugin('cold-default', { runtimeManifest: { defaultForCapabilities: [CAPABILITY] } }),
        );

        const resolved = await facade.resolve(undefined, 'user-1');
        const defaultProvider = await facade.getDefaultProvider(undefined, 'user-1');

        expect(resolved.id).toBe('cold-default');
        expect(defaultProvider?.id).toBe('cold-default');
    });

    it('lists providers with the default, icon, selectable categories and supplementary flag their getManifest() declares', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, plugin('cold-listed'));
        registerColdPlugin(
            registry,
            plugin('cold-listed-default', {
                runtimeManifest: {
                    defaultForCapabilities: [CAPABILITY],
                    icon: { type: 'lucide', value: 'Bot' },
                    selectableProviderCategories: ['screenshot'],
                },
            }),
        );
        registerColdPlugin(
            registry,
            plugin('cold-supplementary', { runtimeManifest: { supplementary: true } }),
        );

        const providers = await facade.getAvailableProvidersForUser('user-1');

        expect(providers).toEqual([
            expect.objectContaining({
                id: 'cold-listed-default',
                isDefault: true,
                icon: { type: 'lucide', value: 'Bot' },
                selectableProviderCategories: ['screenshot'],
            }),
            expect.objectContaining({ id: 'cold-listed', isDefault: false }),
        ]);
    });

    it('skips an enabled cold plugin that cannot be imported', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, plugin('cold-broken', { failing: true }));
        registerColdPlugin(registry, plugin('cold-next'));

        const resolved = await facade.resolve(undefined, 'user-1');

        expect(resolved.id).toBe('cold-next');
        expect(registry.get('cold-broken')?.state).toBe('error');
    });

    it("does not use a Work's active plugin whose onLoad fails", async () => {
        const { registry, facade } = build('cold-active-fails');
        registerColdPlugin(registry, plugin('cold-active-fails', { onLoadFails: true }));
        registerColdPlugin(registry, plugin('cold-healthy'));

        // Compare ids: printing a lazy proxy in a failure message would invoke
        // its forwarding traps.
        expect((await facade.activeForWork('work-1'))?.plugin.id ?? null).toBeNull();
        const resolved = await facade.resolve(undefined, 'user-1', 'work-1');

        expect(resolved.id).toBe('cold-healthy');
        expect(registry.get('cold-active-fails')?.state).toBe('error');
    });

    it('refuses an explicit provider whose onLoad fails', async () => {
        const { registry, facade } = build();
        registerColdPlugin(registry, plugin('cold-override-fails', { onLoadFails: true }));

        await expect(facade.resolve('cold-override-fails', 'user-1')).rejects.toBeInstanceOf(
            ProviderNotFoundError,
        );
    });
});

/**
 * The first requests of a fresh process race on a cold plugin: the proxy marks
 * itself materialised before its first-materialise hook has awaited the
 * loader's manifest DB upsert and run `onLoad`. A second request that resolves
 * its provider inside that window must not be handed an instance whose
 * `onLoad` has not run (openrouter throws "OpenRouter plugin not loaded";
 * many plugins set `this.context` only in onLoad), nor one whose onLoad is
 * about to fail.
 */
describe("BaseFacadeService — a second request during a cold plugin's first load", () => {
    function build() {
        const registry = createRegistry();
        const workPluginRepository = {
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        } as unknown as WorkPluginRepository;
        const facade = new ColdFacade(
            registry as PluginRegistryService,
            undefined,
            workPluginRepository,
        );
        return { registry, facade };
    }

    it('hands the second request the plugin only once its onLoad has run', async () => {
        const { registry, facade } = build();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'cold-slow-provider',
            capabilities: [CAPABILITY],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            firstLoadGate: hold.promise,
        });

        const first = facade.resolve(undefined, 'user-1');
        await settle();
        const second = facade.resolve(undefined, 'user-1').then((plugin) => ({
            id: plugin.id,
            onLoadDoneWhenAnswered: cold.onLoadDone(),
            answer: (plugin as unknown as Pingable).ping(),
        }));
        await settle();
        hold.release();

        await expect(second).resolves.toEqual({
            id: 'cold-slow-provider',
            onLoadDoneWhenAnswered: true,
            answer: 'pong',
        });
        await expect(first.then((plugin) => plugin.id)).resolves.toBe('cold-slow-provider');
    });

    it('never hands the second request a plugin whose onLoad then fails', async () => {
        const { registry, facade } = build();
        const hold = gate();
        registerColdPlugin(registry, {
            id: 'cold-slow-default-fails',
            capabilities: [CAPABILITY],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true, defaultForCapabilities: [CAPABILITY] },
            onLoadFails: true,
            firstLoadGate: hold.promise,
        });
        registerColdPlugin(registry, {
            id: 'cold-healthy-provider',
            capabilities: [CAPABILITY],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const first = facade.resolve(undefined, 'user-1');
        await settle();
        const second = facade.resolve(undefined, 'user-1').then((plugin) => plugin.id);
        const explicit = facade
            .resolve('cold-slow-default-fails', 'user-1')
            .then((plugin) => plugin.id)
            .catch((error: unknown) => error);
        await settle();
        hold.release();

        await expect(second).resolves.toBe('cold-healthy-provider');
        await expect(explicit).resolves.toBeInstanceOf(ProviderNotFoundError);
        await expect(first.then((plugin) => plugin.id)).resolves.toBe('cold-healthy-provider');
        expect(registry.get('cold-slow-default-fails')?.state).toBe('error');
    });
});

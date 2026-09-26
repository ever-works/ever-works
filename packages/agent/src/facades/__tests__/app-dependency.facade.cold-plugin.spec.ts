import { Logger } from '@nestjs/common';
import type { AppDependencyContext, AppDependencyProviderDescriptor } from '@ever-works/plugin';
import { AppDependencyFacadeService, type AppDependencySelection } from '../app-dependency.facade';
import {
    createRegistry,
    registerColdPlugin,
    type ColdPluginSpec,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * Sweep (lazy builtIns) — `AppDependencyFacadeService.resolve` turns a stored
 * `(providerPluginId, providerId)` back into its implementation for a refresh,
 * a retried provision or a deprovision. It read the registry entry's plugin
 * WITHOUT loading it: on a cold lazy proxy (k8s is a builtIn, so it stays cold
 * in a fresh API or worker process until something uses it)
 * `isAppDependencyProvider` read `dependencyProviders` as the proxy's
 * forwarding wrapper — a function, not an array — so `resolve` answered
 * `null`: the dependency was reported `providerNotSupported` (non-transient),
 * or its resources were left in `mayRemain`, though the provider was there.
 */

const PROVIDER_ID = 'k8s-postgres';

const DESCRIPTOR: AppDependencyProviderDescriptor = {
    id: PROVIDER_ID,
    kind: 'postgres',
    targets: ['your-cluster'],
    label: 'Postgres (in-cluster)',
    preference: 10,
    backupPolicy: 'none',
} as AppDependencyProviderDescriptor;

function k8sLike(extra: Partial<ColdPluginSpec> = {}) {
    const provision = jest.fn(async () => ({ state: 'ready' }));
    const getOutputs = jest.fn(async () => ({ DATABASE_URL: 'postgres://x' }));
    const spec: ColdPluginSpec = {
        id: 'k8s',
        category: 'deployment',
        capabilities: ['deployment', 'app-dependency'],
        settingsSchema: { type: 'object', properties: {} } as never,
        builtIn: true,
        manifest: { autoEnable: true },
        ...extra,
        members: {
            dependencyProviders: [DESCRIPTOR],
            supports: async () => ({ supported: true }),
            provision,
            getOutputs,
            deprovision: async () => ({ state: 'released' }),
            backupStatus: async () => ({ state: 'none' }),
            ...(extra.members ?? {}),
        },
    };
    return { spec, provision, getOutputs };
}

const CTX = { workId: 'work-1' } as unknown as AppDependencyContext;

function selection(): AppDependencySelection {
    return {
        providerPluginId: 'k8s',
        providerId: PROVIDER_ID,
        label: DESCRIPTOR.label,
        backupPolicy: DESCRIPTOR.backupPolicy,
        awaitingConfig: false,
        descriptor: DESCRIPTOR,
    };
}

describe('AppDependencyFacadeService — a stored provider over a cold lazy plugin', () => {
    it('resolves the stored pair on a plugin nothing has loaded yet', async () => {
        const registry = createRegistry();
        const { spec } = k8sLike();
        registerColdPlugin(registry, spec);
        const facade = new AppDependencyFacadeService(registry);

        const resolved = await facade.resolve('k8s', PROVIDER_ID, 'postgres');

        expect(resolved).not.toBeNull();
        expect(resolved?.selection).toMatchObject({
            providerPluginId: 'k8s',
            providerId: PROVIDER_ID,
        });
    });

    it('provisions and reads outputs through a stored selection on a cold plugin', async () => {
        const registry = createRegistry();
        const { spec, provision, getOutputs } = k8sLike();
        registerColdPlugin(registry, spec);
        const facade = new AppDependencyFacadeService(registry);

        await expect(facade.provision(selection(), CTX)).resolves.toEqual({ state: 'ready' });
        await expect(facade.getOutputs(selection(), CTX)).resolves.toEqual({
            DATABASE_URL: 'postgres://x',
        });
        expect(provision).toHaveBeenCalledWith(PROVIDER_ID, CTX);
        expect(getOutputs).toHaveBeenCalledWith(PROVIDER_ID, CTX);
    });

    it('still answers null for a provider id the loaded plugin does not declare', async () => {
        const registry = createRegistry();
        const { spec } = k8sLike();
        registerColdPlugin(registry, spec);
        const facade = new AppDependencyFacadeService(registry);

        await expect(facade.resolve('k8s', 'no-such-provider')).resolves.toBeNull();
    });

    it('answers null when the plugin cannot be imported', async () => {
        const registry = createRegistry();
        const { spec } = k8sLike({ failing: true });
        registerColdPlugin(registry, spec);
        const facade = new AppDependencyFacadeService(registry);

        await expect(facade.resolve('k8s', PROVIDER_ID)).resolves.toBeNull();
        await expect(facade.provision(selection(), CTX)).rejects.toMatchObject({
            name: 'AppDependencyProviderNotFoundError',
        });
    });
});

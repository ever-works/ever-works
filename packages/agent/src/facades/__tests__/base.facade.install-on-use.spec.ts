import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { IPlugin } from '@ever-works/plugin';
import { BaseFacadeService, ProviderNotFoundError } from '../base.facade';
import { SearchFacadeService } from '../search.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import { FacadePluginAvailabilityService } from '../../plugins/services/facade-plugin-availability.service';

/**
 * FR-15 / T26 (owner decision 2026-09-25) — a facade that resolves a plugin
 * this process has NOT registered asks `FacadePluginAvailabilityService` for it
 * (install-on-use; dynamic distribution + `facadeInstallOnUse` only) and uses
 * the entry it answers.
 *
 * Pinned:
 * 1. An explicit provider override and the Work's active plugin are the two
 *    lookups that ask — the ones that name a plugin by id.
 * 2. The service is property-injected, so no facade constructor changes: a
 *    facade built with `new` (or in a graph without it, like the Trigger
 *    worker) behaves exactly as before.
 * 3. Nest injects it into a real facade.
 */

const CAPABILITY = 'search';

@Injectable()
class ProbeFacade extends BaseFacadeService {
    protected readonly CAPABILITY = CAPABILITY;
    protected readonly logger = new Logger('ProbeFacade');

    resolve(providerOverride?: string, userId?: string, workId?: string) {
        return this.resolvePlugin<IPlugin>(providerOverride, userId, workId);
    }
}

function entry(id: string, exec: Record<string, unknown> = {}): RegisteredPlugin {
    return {
        plugin: { id, name: id, capabilities: [CAPABILITY], ...exec } as unknown as IPlugin,
        manifest: { id, name: id, capabilities: [CAPABILITY] } as never,
        state: 'loaded',
    } as unknown as RegisteredPlugin;
}

function makeWorld() {
    const registered = new Map<string, RegisteredPlugin>();
    const registry = {
        get: jest.fn((id: string) => registered.get(id)),
        getByCapability: jest.fn(() => [...registered.values()]),
        isPluginEnabledForScope: jest.fn(async () => true),
    } as unknown as PluginRegistryService;
    const availability = {
        ensureRegistered: jest.fn(async (id: string) => {
            if (!registered.has(id)) registered.set(id, entry(id));
            return registered.get(id);
        }),
    };
    const workPlugins = {
        findActiveByCapability: jest.fn(async () => null as { pluginId: string } | null),
    };
    return { registered, registry, availability, workPlugins };
}

function probe(world: ReturnType<typeof makeWorld>, withAvailability: boolean) {
    const facade = new ProbeFacade(
        world.registry,
        undefined,
        world.workPlugins as unknown as WorkPluginRepository,
    );
    if (withAvailability) {
        // What Nest's property injection does (pinned by the wiring test below).
        (facade as unknown as { pluginAvailability: unknown }).pluginAvailability =
            world.availability;
    }
    return facade;
}

describe('BaseFacadeService — install-on-use for a plugin this process has not registered (FR-15 / T26)', () => {
    it('an explicit override that is not registered here is asked for, then used', async () => {
        const world = makeWorld();

        const plugin = await probe(world, true).resolve('notion-search', 'u1', 'w1');

        expect(world.availability.ensureRegistered).toHaveBeenCalledWith('notion-search');
        expect(plugin.id).toBe('notion-search');
    });

    it('the Work’s active plugin that is not registered here is asked for, then used', async () => {
        const world = makeWorld();
        world.registered.set('tavily', entry('tavily'));
        world.workPlugins.findActiveByCapability.mockResolvedValue({ pluginId: 'exa' });

        const plugin = await probe(world, true).resolve(undefined, 'u1', 'w1');

        expect(world.workPlugins.findActiveByCapability).toHaveBeenCalledWith('w1', CAPABILITY);
        expect(world.availability.ensureRegistered).toHaveBeenCalledWith('exa');
        expect(plugin.id).toBe('exa');
    });

    it('an override the service answers as absent is still ProviderNotFoundError', async () => {
        const world = makeWorld();
        world.availability.ensureRegistered.mockResolvedValueOnce(undefined);

        await expect(probe(world, true).resolve('ghost', 'u1', 'w1')).rejects.toBeInstanceOf(
            ProviderNotFoundError,
        );
    });

    it('without the service (a facade built with `new`), an unregistered override is ProviderNotFoundError, as before', async () => {
        const world = makeWorld();

        await expect(
            probe(world, false).resolve('notion-search', 'u1', 'w1'),
        ).rejects.toBeInstanceOf(ProviderNotFoundError);
        expect(world.availability.ensureRegistered).not.toHaveBeenCalled();
    });

    it('without the service, an unregistered Work-active plugin falls through to the enabled list, as before', async () => {
        const world = makeWorld();
        world.registered.set('tavily', entry('tavily'));
        world.workPlugins.findActiveByCapability.mockResolvedValue({ pluginId: 'exa' });

        await expect(probe(world, false).resolve(undefined, 'u1', 'w1')).resolves.toMatchObject({
            id: 'tavily',
        });
    });

    it('Nest injects the service into a real facade (SearchFacadeService) and the facade uses it', async () => {
        const world = makeWorld();
        const search = jest.fn(async () => ({ results: [] }));
        world.availability.ensureRegistered.mockImplementation(async (id: string) => {
            world.registered.set(id, entry(id, { search }));
            return world.registered.get(id);
        });
        const moduleRef = await Test.createTestingModule({
            providers: [
                SearchFacadeService,
                { provide: PluginRegistryService, useValue: world.registry },
                {
                    provide: PluginSettingsService,
                    useValue: { getSettings: jest.fn(async () => ({})) },
                },
                { provide: FacadePluginAvailabilityService, useValue: world.availability },
            ],
        }).compile();

        await moduleRef
            .get(SearchFacadeService)
            .search('q', undefined, { userId: 'u1', providerOverride: 'exa' });

        expect(world.availability.ensureRegistered).toHaveBeenCalledWith('exa');
        expect(search).toHaveBeenCalledTimes(1);
        await moduleRef.close();
    });

    it('a real facade boots without the service bound, and behaves as before', async () => {
        const world = makeWorld();
        const moduleRef = await Test.createTestingModule({
            providers: [
                SearchFacadeService,
                { provide: PluginRegistryService, useValue: world.registry },
                {
                    provide: PluginSettingsService,
                    useValue: { getSettings: jest.fn(async () => ({})) },
                },
            ],
        }).compile();

        await expect(
            moduleRef
                .get(SearchFacadeService)
                .search('q', undefined, { userId: 'u1', providerOverride: 'exa' }),
        ).rejects.toBeInstanceOf(ProviderNotFoundError);
        await moduleRef.close();
    });
});

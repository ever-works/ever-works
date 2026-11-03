import { Logger } from '@nestjs/common';
import type { VectorStoreCapabilities } from '@ever-works/plugin';
import { VectorStoreFacadeService, VectorStoreNotConfiguredError } from '../vector-store.facade';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
    type ColdPluginSpec,
    type Pingable,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const VECTOR_STORE = 'vector-store';

const vectorCapabilities = {
    supportsMetadataFilter: true,
    supportsHybridSearch: false,
    supportsNamespaces: true,
    supportsDelete: true,
    nativeDimensions: 0,
    embedsOnWrite: true,
} as VectorStoreCapabilities;

/**
 * `select()` picks a vector store by `defaultForCapabilities`, which a plugin
 * may declare only in its class's getManifest() — and a cold lazy proxy's
 * registry entry does not carry that until the plugin loads. Its callers then
 * read `vectorCapabilities` synchronously (`EmbeddingModeResolver`), which a
 * cold proxy answers with an async forwarding wrapper. These specs register
 * REAL lazy proxies and prove `select()` loads before it picks, and answers
 * the real, loaded instance.
 */
describe('VectorStoreFacadeService.select — cold lazy vector-store plugins', () => {
    function build(workPluginRepository?: Pick<WorkPluginRepository, 'findActiveByCapability'>) {
        const registry = createRegistry();
        const facade = new VectorStoreFacadeService(
            registry,
            workPluginRepository as WorkPluginRepository | undefined,
        );
        return { registry, facade };
    }

    function registerVectorStore(
        registry: PluginRegistryService,
        id: string,
        extra: Partial<ColdPluginSpec> = {},
    ) {
        return registerColdPlugin(registry, {
            id,
            category: VECTOR_STORE,
            capabilities: [VECTOR_STORE],
            settingsSchema: requiredSecretSchema(),
            members: { vectorCapabilities },
            ...extra,
        });
    }

    beforeEach(() => {
        delete process.env.KB_VECTOR_STORE_PROVIDER_ID;
    });

    afterEach(() => {
        delete process.env.KB_VECTOR_STORE_PROVIDER_ID;
    });

    it('picks the cold provider whose getManifest() declares defaultForCapabilities over the first by id', async () => {
        const { registry, facade } = build();
        // First by id, and no default: the pick a cold registry would make.
        registerVectorStore(registry, 'a-vector-store');
        const preferred = registerVectorStore(registry, 'b-vector-store', {
            runtimeManifest: { defaultForCapabilities: [VECTOR_STORE] },
        });

        const resolved = await facade.select({ workId: 'w1', userId: 'u1' });

        expect(resolved.id).toBe('b-vector-store');
        // The real instance, its onLoad run: sync members answer values.
        expect(Object.is(resolved, preferred.proxy)).toBe(false);
        expect(resolved.vectorCapabilities.embedsOnWrite).toBe(true);
        expect((resolved as unknown as Pingable).ping()).toBe('pong');
    });

    it('skips a cold default that cannot be imported and picks the next candidate', async () => {
        const { registry, facade } = build();
        registerVectorStore(registry, 'a-vector-store', {
            manifest: { defaultForCapabilities: [VECTOR_STORE] },
            failing: true,
        });
        registerVectorStore(registry, 'b-vector-store');

        const resolved = await facade.select({ workId: 'w1', userId: 'u1' });

        expect(resolved.id).toBe('b-vector-store');
        expect(registry.get('a-vector-store')?.state).toBe('error');
    });

    it('answers the loaded instance for a cold caller-pinned provider', async () => {
        const { registry, facade } = build();
        const pinned = registerVectorStore(registry, 'pinned-vector-store');

        const resolved = await facade.select({
            workId: 'w1',
            userId: 'u1',
            providerOverride: 'pinned-vector-store',
        });

        expect(Object.is(resolved, pinned.proxy)).toBe(false);
        expect(pinned.onLoadDone()).toBe(true);
        expect(resolved.vectorCapabilities.embedsOnWrite).toBe(true);
        expect((resolved as unknown as Pingable).ping()).toBe('pong');
    });

    it('hard-fails a caller pin whose cold provider cannot be imported', async () => {
        const { registry, facade } = build();
        registerVectorStore(registry, 'broken-vector-store', { failing: true });

        // Mapped to a plain value first: were a cold proxy answered, jest's
        // printer would probe it (`hasAttribute`) and load the broken plugin.
        const outcome = await facade
            .select({ workId: 'w1', userId: 'u1', providerOverride: 'broken-vector-store' })
            .then(
                () => 'resolved',
                (error: unknown) => error,
            );

        expect(outcome).toBeInstanceOf(VectorStoreNotConfiguredError);
        expect(registry.get('broken-vector-store')?.state).toBe('error');
    });

    it('answers the loaded instance for a cold scope-active provider', async () => {
        const findActiveByCapability = jest
            .fn()
            .mockResolvedValue({ pluginId: 'active-vector-store' });
        const { registry, facade } = build({ findActiveByCapability });
        registerVectorStore(registry, 'a-default-vector-store', {
            manifest: { defaultForCapabilities: [VECTOR_STORE] },
        });
        const active = registerVectorStore(registry, 'active-vector-store');

        const resolved = await facade.select({ workId: 'w1', userId: 'u1' });

        expect(findActiveByCapability).toHaveBeenCalledWith('w1', VECTOR_STORE);
        expect(resolved.id).toBe('active-vector-store');
        expect(Object.is(resolved, active.proxy)).toBe(false);
        expect(resolved.vectorCapabilities.embedsOnWrite).toBe(true);
    });
});

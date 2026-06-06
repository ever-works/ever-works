/**
 * EW-642 — `VectorStoreFacadeService` + `EmbeddingModeResolver` unit tests.
 *
 * Mirrors the AiFacadeService.transcribe spec shape. The facade is
 * exercised in isolation via mocked `PluginRegistryService` +
 * `WorkPluginRepository`; the concrete `IVectorStorePlugin` is the
 * in-memory fake from the contract suite.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
    VectorStoreFacadeService,
    VectorStoreNotConfiguredError,
    EmbeddingModeResolver,
    EmbeddingModeUnsupportedError,
} from './vector-store.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { InMemoryVectorStorePlugin } from '../../../plugin/src/contracts/__tests__/fakes/in-memory-vector-store';
import type {
    IVectorStorePlugin,
    PluginManifest,
    VectorStoreCapabilities,
} from '@ever-works/plugin';

describe('VectorStoreFacadeService', () => {
    let service: VectorStoreFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let workPluginRepository: { findActiveByCapability: jest.Mock };

    const createMockVectorPlugin = (
        id: string,
        opts: { embedsOnWrite?: boolean } = {},
    ): IVectorStorePlugin => {
        const fake = new InMemoryVectorStorePlugin();
        // Override the readonly fields the facade actually looks at.
        Object.defineProperty(fake, 'id', { value: id });
        if (opts.embedsOnWrite !== undefined) {
            const caps: VectorStoreCapabilities = {
                ...fake.vectorCapabilities,
                embedsOnWrite: opts.embedsOnWrite,
            };
            Object.defineProperty(fake, 'vectorCapabilities', { value: caps });
        }
        return fake;
    };

    const createRegisteredPlugin = (
        plugin: IVectorStorePlugin,
        manifest: Partial<PluginManifest> = {},
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test vector-store plugin',
            category: 'vector-store',
            capabilities: ['vector-store'],
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        workPluginRepository = {
            findActiveByCapability: jest.fn().mockResolvedValue(null),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                VectorStoreFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: WorkPluginRepository,
                    useValue: workPluginRepository,
                },
            ],
        }).compile();

        service = module.get<VectorStoreFacadeService>(VectorStoreFacadeService);
        registry = module.get(PluginRegistryService);

        // Ensure the env pin doesn't leak between tests.
        delete process.env.KB_VECTOR_STORE_PROVIDER_ID;
    });

    afterEach(() => {
        delete process.env.KB_VECTOR_STORE_PROVIDER_ID;
    });

    describe('select()', () => {
        it('1. providerOverride routes to the matching plugin', async () => {
            const pgvector = createMockVectorPlugin('pgvector-plugin');
            const qdrant = createMockVectorPlugin('qdrant-plugin');

            registry.get.mockImplementation((id: string) => {
                if (id === 'qdrant-plugin') return createRegisteredPlugin(qdrant);
                if (id === 'pgvector-plugin') return createRegisteredPlugin(pgvector);
                return undefined;
            });

            const resolved = await service.select({
                workId: 'w1',
                userId: 'u1',
                providerOverride: 'qdrant-plugin',
            });

            expect(resolved.id).toBe('qdrant-plugin');
        });

        it('2. providerOverride that does not exist throws VectorStoreNotConfiguredError', async () => {
            registry.get.mockReturnValue(undefined);

            await expect(
                service.select({
                    workId: 'w1',
                    userId: 'u1',
                    providerOverride: 'nope-plugin',
                }),
            ).rejects.toBeInstanceOf(VectorStoreNotConfiguredError);
        });

        it('3. operator env pin (KB_VECTOR_STORE_PROVIDER_ID) routes to that plugin', async () => {
            const pinned = createMockVectorPlugin('pinecone-plugin');
            process.env.KB_VECTOR_STORE_PROVIDER_ID = 'pinecone-plugin';
            registry.get.mockReturnValue(createRegisteredPlugin(pinned));

            const resolved = await service.select({ workId: 'w1', userId: 'u1' });

            expect(resolved.id).toBe('pinecone-plugin');
            expect(registry.get).toHaveBeenCalledWith('pinecone-plugin');
        });

        it('4. scope-active plugin is returned when no override is set', async () => {
            const pgvector = createMockVectorPlugin('pgvector-plugin');
            const qdrant = createMockVectorPlugin('qdrant-plugin');

            workPluginRepository.findActiveByCapability.mockResolvedValue({
                pluginId: 'qdrant-plugin',
                capability: 'vector-store',
            });
            registry.get.mockImplementation((id: string) => {
                if (id === 'qdrant-plugin') return createRegisteredPlugin(qdrant);
                return undefined;
            });
            // Registry default would prefer pgvector; scope-active must win.
            registry.getByCapability.mockReturnValue([createRegisteredPlugin(pgvector)]);

            const resolved = await service.select({ workId: 'w1', userId: 'u1' });

            expect(resolved.id).toBe('qdrant-plugin');
        });

        it('5. registry-default plugin returned when no override and no scope-active plugin', async () => {
            const pgvector = createMockVectorPlugin('pgvector-plugin');

            workPluginRepository.findActiveByCapability.mockResolvedValue(null);
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(pgvector, {
                    defaultForCapabilities: ['vector-store'],
                }),
            ]);

            const resolved = await service.select({ workId: 'w1', userId: 'u1' });

            expect(resolved.id).toBe('pgvector-plugin');
        });

        it('6. throws VectorStoreNotConfiguredError when no selectable plugin exists', async () => {
            workPluginRepository.findActiveByCapability.mockResolvedValue(null);
            registry.getByCapability.mockReturnValue([]);

            await expect(service.select({ workId: 'w1', userId: 'u1' })).rejects.toBeInstanceOf(
                VectorStoreNotConfiguredError,
            );
        });
    });

    describe('EmbeddingModeResolver', () => {
        let resolver: EmbeddingModeResolver;
        const originalEnv = process.env.KB_EMBEDDING_MODE;

        beforeEach(() => {
            resolver = new EmbeddingModeResolver();
            delete process.env.KB_EMBEDDING_MODE;
        });

        afterEach(() => {
            if (originalEnv !== undefined) {
                process.env.KB_EMBEDDING_MODE = originalEnv;
            } else {
                delete process.env.KB_EMBEDDING_MODE;
            }
        });

        it('7. explicit Work-level setting wins over org / env / auto', async () => {
            const plugin = createMockVectorPlugin('pgvector-plugin', { embedsOnWrite: true });
            process.env.KB_EMBEDDING_MODE = 'plugin';

            const mode = resolver.resolve({
                workId: 'w1',
                resolvedVectorStorePlugin: plugin,
                workEmbeddingMode: 'platform',
                orgEmbeddingMode: 'plugin',
            });

            expect(mode).toBe('platform');
        });

        it("8. 'auto' picks 'plugin' when capabilities.embedsOnWrite=true, else 'platform'", async () => {
            const embedsOnWrite = createMockVectorPlugin('weaviate-plugin', {
                embedsOnWrite: true,
            });
            const callerEmbeds = createMockVectorPlugin('pgvector-plugin', {
                embedsOnWrite: false,
            });

            // 'auto' against an embedsOnWrite=true backend → 'plugin'.
            const autoMode = resolver.resolve({
                workId: 'w1',
                resolvedVectorStorePlugin: embedsOnWrite,
                workEmbeddingMode: 'auto',
                orgEmbeddingMode: 'auto',
            });
            expect(autoMode).toBe('plugin');

            // 'auto' against an embedsOnWrite=false backend → 'platform'.
            const platformMode = resolver.resolve({
                workId: 'w1',
                resolvedVectorStorePlugin: callerEmbeds,
                workEmbeddingMode: 'auto',
                orgEmbeddingMode: 'auto',
            });
            expect(platformMode).toBe('platform');
        });

        it("9. 'plugin' mode + embedsOnWrite=false throws EmbeddingModeUnsupportedError", async () => {
            const plugin = createMockVectorPlugin('pgvector-plugin', {
                embedsOnWrite: false,
            });

            expect(() =>
                resolver.resolve({
                    workId: 'w1',
                    resolvedVectorStorePlugin: plugin,
                    workEmbeddingMode: 'plugin',
                }),
            ).toThrow(EmbeddingModeUnsupportedError);
        });
    });
});

import { CustomCapabilityRegistryService } from '../../plugins/services/custom-capability-registry.service';
import {
    VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY,
    VECTOR_STORE_HOST_PROVIDER,
    VectorStoreHostChunkTablesService,
    type HostChunkTables,
} from '../vector-store-host-chunk-tables.service';
import type { WorkKnowledgeChunkRepository } from '../../database/repositories/work-knowledge-chunk.repository';
import type { VectorNamespaceChunkRepository } from '../../database/repositories/vector-namespace-chunk.repository';

/**
 * AW-07 — the API's wiring of the bundled pgvector store.
 *
 * Before this service nothing ever handed the pgvector plugin its host chunk
 * repository, so every pgvector call threw "not wired" and both the Knowledge
 * Base and memory facts degraded. The service publishes the platform's two
 * chunk tables through the plugin host's existing custom-capability registry
 * (what `PluginContext.getCustomCapability()` reads).
 *
 * Pinned here:
 *  - the capability name (the plugin pins the same literal on its side) and
 *    one registration per process;
 *  - Work-scoped KB calls reach `WorkKnowledgeChunkRepository` with exactly
 *    the arguments the plugin passed — the KB path is a pass-through;
 *  - non-Work namespaces reach `VectorNamespaceChunkRepository`;
 *  - the Work probe caches only positive answers;
 *  - availability means "Postgres with the vector extension".
 */
describe('VectorStoreHostChunkTablesService', () => {
    const WORK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const NS = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';

    function portMock() {
        return {
            replaceForDocument: jest.fn().mockResolvedValue(undefined),
            findNearestByEmbedding: jest.fn().mockResolvedValue([]),
            deleteByDocument: jest.fn().mockResolvedValue(undefined),
            deleteByWork: jest.fn().mockResolvedValue(undefined),
        };
    }

    function build(driver: 'postgres' | 'better-sqlite3' = 'postgres') {
        const registry = new CustomCapabilityRegistryService();
        const workChunks = portMock();
        const namespaceChunks = portMock();
        const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
        const works = {
            exists: jest.fn().mockResolvedValue(false),
            manager: { connection: { options: { type: driver } }, query },
        };
        const service = new VectorStoreHostChunkTablesService(
            registry,
            workChunks as unknown as WorkKnowledgeChunkRepository,
            namespaceChunks as unknown as VectorNamespaceChunkRepository,
            works as never,
        );
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        return { registry, workChunks, namespaceChunks, works, query, service };
    }

    it('publishes the chunk tables under the shared capability name, once', () => {
        const { registry, service } = build();
        expect(VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY).toBe('vector-store:host-chunk-tables');

        service.onModuleInit();
        service.onModuleInit();

        expect(registry.getProvider(VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY)).toBe(
            VECTOR_STORE_HOST_PROVIDER,
        );
        const tables = registry.getImplementation<HostChunkTables>(
            VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY,
        );
        expect(Object.keys(tables!).sort()).toEqual(
            [
                'chunkRepository',
                'namespaceChunkRepository',
                'pingDatabase',
                'workNamespaces',
            ].sort(),
        );
        for (const port of [tables!.chunkRepository, tables!.namespaceChunkRepository]) {
            expect(Object.keys(port).sort()).toEqual(
                [
                    'deleteByDocument',
                    'deleteByWork',
                    'findNearestByEmbedding',
                    'replaceForDocument',
                ].sort(),
            );
        }
    });

    it('Work-scoped KB calls are a pass-through to WorkKnowledgeChunkRepository (unchanged path)', async () => {
        const { service, workChunks, namespaceChunks } = build();
        const rows = [
            {
                id: 'c-0',
                documentId: 'd-1',
                chunkIndex: 0,
                content: 'kb',
                tokenCount: 1,
                embedding: [0.1],
                metadata: null,
            },
        ];
        const nearest = [
            {
                id: 'c-0',
                workId: WORK_ID,
                documentId: 'd-1',
                chunkIndex: 0,
                content: 'kb',
                distance: 0.2,
            },
        ];
        workChunks.findNearestByEmbedding.mockResolvedValue(nearest);
        const { chunkRepository } = service.tables();

        await chunkRepository.replaceForDocument(WORK_ID, 'd-1', rows);
        await expect(chunkRepository.findNearestByEmbedding(WORK_ID, [0.1], 4)).resolves.toBe(
            nearest,
        );
        await chunkRepository.deleteByDocument(WORK_ID, 'd-1');
        await chunkRepository.deleteByWork(WORK_ID);

        expect(workChunks.replaceForDocument).toHaveBeenCalledWith(WORK_ID, 'd-1', rows);
        expect(workChunks.replaceForDocument.mock.calls[0][2]).toBe(rows);
        expect(workChunks.findNearestByEmbedding).toHaveBeenCalledWith(WORK_ID, [0.1], 4);
        expect(workChunks.deleteByDocument).toHaveBeenCalledWith(WORK_ID, 'd-1');
        expect(workChunks.deleteByWork).toHaveBeenCalledWith(WORK_ID);
        expect(namespaceChunks.replaceForDocument).not.toHaveBeenCalled();
        expect(namespaceChunks.findNearestByEmbedding).not.toHaveBeenCalled();
    });

    it('non-Work namespaces go to VectorNamespaceChunkRepository', async () => {
        const { service, workChunks, namespaceChunks } = build();
        const { namespaceChunkRepository } = service.tables();

        await namespaceChunkRepository.replaceForDocument(NS, 'f-1', []);
        await namespaceChunkRepository.findNearestByEmbedding(NS, [0.3], 2);
        await namespaceChunkRepository.deleteByDocument(NS, 'f-1');
        await namespaceChunkRepository.deleteByWork(NS);

        expect(namespaceChunks.replaceForDocument).toHaveBeenCalledWith(NS, 'f-1', []);
        expect(namespaceChunks.findNearestByEmbedding).toHaveBeenCalledWith(NS, [0.3], 2);
        expect(namespaceChunks.deleteByDocument).toHaveBeenCalledWith(NS, 'f-1');
        expect(namespaceChunks.deleteByWork).toHaveBeenCalledWith(NS);
        expect(workChunks.replaceForDocument).not.toHaveBeenCalled();
    });

    it('the Work probe caches a Work, but never caches "not a Work"', async () => {
        const { service, works } = build();
        works.exists.mockImplementation(
            async ({ where }: { where: { id: string } }) => where.id === WORK_ID,
        );

        await expect(service.isWork(WORK_ID)).resolves.toBe(true);
        await expect(service.isWork(WORK_ID)).resolves.toBe(true);
        expect(works.exists).toHaveBeenCalledTimes(1);

        await expect(service.isWork(NS)).resolves.toBe(false);
        await expect(service.isWork(NS)).resolves.toBe(false);
        expect(works.exists).toHaveBeenCalledTimes(3);
        expect(works.exists).toHaveBeenCalledWith({ where: { id: NS } });
    });

    it('is unavailable on SQLite without touching the database', async () => {
        const { service, query } = build('better-sqlite3');
        await expect(service.pingDatabase()).resolves.toBe(false);
        expect(query).not.toHaveBeenCalled();
    });

    it('is available on Postgres only when the vector extension is installed, and caches a yes', async () => {
        const { service, query } = build('postgres');
        await expect(service.pingDatabase()).resolves.toBe(true);
        await expect(service.pingDatabase()).resolves.toBe(true);
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0]).toContain("extname = 'vector'");
    });

    it('re-checks a missing vector extension after a minute, and treats a probe error as unavailable', async () => {
        const { service, query } = build('postgres');
        query.mockResolvedValueOnce([]);
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

        await expect(service.pingDatabase()).resolves.toBe(false);
        await expect(service.pingDatabase()).resolves.toBe(false);
        expect(query).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_000_000 + 61_000);
        query.mockRejectedValueOnce(new Error('permission denied'));
        await expect(service.pingDatabase()).resolves.toBe(false);
        expect(query).toHaveBeenCalledTimes(2);
        now.mockRestore();
    });
});

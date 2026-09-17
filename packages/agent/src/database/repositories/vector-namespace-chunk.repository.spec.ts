import { DataSource, Repository } from 'typeorm';
import { VectorNamespaceChunk } from '../../entities/vector-namespace-chunk.entity';
import { VectorNamespaceChunkRepository } from './vector-namespace-chunk.repository';

/**
 * AW-07 — `vector_namespace_chunks`, the pgvector store's table for vector
 * namespaces that are not a Work.
 *
 * Two harnesses, because the two halves of the isolation guarantee live in
 * two places:
 *
 *  - writes and deletes run on a REAL SQL engine (better-sqlite3), proving
 *    the database itself keeps one namespace's rows out of another's replace
 *    and delete;
 *  - the pgvector k-NN only exists on Postgres, so its statement is asserted
 *    against a recording manager: the namespace predicate and its bound
 *    parameter are what keep a query in one workspace's namespace from ever
 *    returning another's vectors. CI has no pgvector Postgres; the same SQL
 *    shape is what `WorkKnowledgeChunkRepository` runs in production.
 */
describe('VectorNamespaceChunkRepository', () => {
    const NS_A = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';
    const NS_B = 'cccccccc-cccc-5ccc-8ccc-cccccccccccc';
    const FACT_1 = '11111111-1111-4111-8111-111111111111';
    const FACT_2 = '22222222-2222-4222-8222-222222222222';

    const chunk = (id: string, content: string, embedding: number[] = [0.1, 0.2]) => ({
        id,
        documentId: id,
        chunkIndex: 0,
        content,
        tokenCount: 4,
        embedding,
        metadata: { kind: 'memory-fact', scope: 'workspace' },
        tenantId: 't-1',
        organizationId: 'o-1',
    });

    describe('writes and deletes (better-sqlite3)', () => {
        let dataSource: DataSource;
        let repo: Repository<VectorNamespaceChunk>;
        let chunks: VectorNamespaceChunkRepository;

        beforeEach(async () => {
            dataSource = new DataSource({
                type: 'better-sqlite3',
                database: ':memory:',
                entities: [VectorNamespaceChunk],
                synchronize: true,
            });
            await dataSource.initialize();
            repo = dataSource.getRepository(VectorNamespaceChunk);
            chunks = new VectorNamespaceChunkRepository(repo);
        });

        afterEach(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        it('replaces a document inside its namespace only, recording the owning workspace', async () => {
            await chunks.replaceForDocument(NS_A, FACT_1, [chunk(FACT_1, 'A: first body')]);
            await chunks.replaceForDocument(NS_B, FACT_1, [chunk(FACT_1, 'B: same fact id')]);
            await chunks.replaceForDocument(NS_A, FACT_1, [chunk(FACT_1, 'A: edited body')]);

            const inA = await chunks.findByNamespaceAndDocument(NS_A, FACT_1);
            const inB = await chunks.findByNamespaceAndDocument(NS_B, FACT_1);
            expect(inA.map((r) => r.content)).toEqual(['A: edited body']);
            expect(inB.map((r) => r.content)).toEqual(['B: same fact id']);
            expect(inA[0]).toMatchObject({
                namespaceId: NS_A,
                tenantId: 't-1',
                organizationId: 'o-1',
                embedding: [0.1, 0.2],
                metadata: { kind: 'memory-fact', scope: 'workspace' },
            });
        });

        it('takes the namespace from the argument, never from the input row', async () => {
            await chunks.replaceForDocument(NS_A, FACT_1, [
                { ...chunk(FACT_1, 'x'), namespaceId: NS_B } as never,
            ]);
            expect(await repo.count({ where: { namespaceId: NS_B } })).toBe(0);
            expect(await repo.count({ where: { namespaceId: NS_A } })).toBe(1);
        });

        it('an empty replace deletes only that document in that namespace', async () => {
            await chunks.replaceForDocument(NS_A, FACT_1, [chunk(FACT_1, 'a1')]);
            await chunks.replaceForDocument(NS_A, FACT_2, [chunk(FACT_2, 'a2')]);
            await chunks.replaceForDocument(NS_B, FACT_1, [chunk(FACT_1, 'b1')]);

            await chunks.replaceForDocument(NS_A, FACT_1, []);

            expect(await repo.count({ where: { namespaceId: NS_A } })).toBe(1);
            expect(await repo.count({ where: { namespaceId: NS_B } })).toBe(1);
        });

        it('deleteByDocument and deleteByWork never reach into another namespace', async () => {
            await chunks.replaceForDocument(NS_A, FACT_1, [chunk(FACT_1, 'a1')]);
            await chunks.replaceForDocument(NS_A, FACT_2, [chunk(FACT_2, 'a2')]);
            await chunks.replaceForDocument(NS_B, FACT_1, [chunk(FACT_1, 'b1')]);

            await chunks.deleteByDocument(NS_A, FACT_1);
            expect(await chunks.findByNamespaceAndDocument(NS_B, FACT_1)).toHaveLength(1);
            expect(await repo.count({ where: { namespaceId: NS_A } })).toBe(1);

            await chunks.deleteByWork(NS_A);
            expect(await repo.count({ where: { namespaceId: NS_A } })).toBe(0);
            expect(await repo.count({ where: { namespaceId: NS_B } })).toBe(1);
        });

        it('k-NN returns [] on a non-Postgres driver (no pgvector — exact-words fallback)', async () => {
            await chunks.replaceForDocument(NS_A, FACT_1, [chunk(FACT_1, 'a1')]);
            await expect(chunks.findNearestByEmbedding(NS_A, [0.1, 0.2], 5)).resolves.toEqual([]);
        });
    });

    describe('k-NN statement (Postgres)', () => {
        let query: jest.Mock;
        let chunks: VectorNamespaceChunkRepository;

        beforeEach(() => {
            query = jest.fn().mockResolvedValue([
                {
                    id: FACT_1,
                    workId: NS_A,
                    documentId: FACT_1,
                    chunkIndex: 0,
                    content: 'a1',
                    distance: '0.125',
                },
            ]);
            chunks = new VectorNamespaceChunkRepository({
                manager: { connection: { options: { type: 'postgres' } }, query },
            } as never);
        });

        it('filters on the namespace BEFORE ranking, with the namespace bound as a parameter', async () => {
            const rows = await chunks.findNearestByEmbedding(NS_A, [0.5, 0.25], 3);

            const [sql, params] = query.mock.calls[0] as [string, unknown[]];
            const flat = sql.replace(/\s+/g, ' ');
            expect(flat).toContain('FROM vector_namespace_chunks');
            expect(flat).toContain('WHERE namespace_id = $2');
            expect(flat).toContain('ORDER BY embedding <=> $1::vector ASC LIMIT $3');
            expect(flat.indexOf('WHERE namespace_id = $2')).toBeLessThan(flat.indexOf('ORDER BY'));
            expect(params).toEqual(['[0.5,0.25]', NS_A, 3]);
            // Never interpolated into the statement.
            expect(sql).not.toContain(NS_A);
            expect(rows).toEqual([
                {
                    id: FACT_1,
                    workId: NS_A,
                    documentId: FACT_1,
                    chunkIndex: 0,
                    content: 'a1',
                    distance: 0.125,
                },
            ]);
        });

        it('fires no query for an empty embedding or a non-positive limit', async () => {
            await expect(chunks.findNearestByEmbedding(NS_A, [], 3)).resolves.toEqual([]);
            await expect(chunks.findNearestByEmbedding(NS_A, [0.1], 0)).resolves.toEqual([]);
            expect(query).not.toHaveBeenCalled();
        });
    });
});

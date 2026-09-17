import { MemoryFactVectorIndexService } from '../memory-fact-vector-index.service';
import type { AiFacadeService } from '../../facades/ai.facade';
import {
    VectorStoreNotConfiguredError,
    type VectorStoreFacadeService,
} from '../../facades/vector-store.facade';

const KEY = { userId: 'u-1', organizationId: 'o-1', tenantId: 't-1' };

describe('MemoryFactVectorIndexService', () => {
    let ai: { embed: jest.Mock };
    let plugin: { id: string; upsertChunks: jest.Mock; isAvailable: jest.Mock };
    let facade: { select: jest.Mock; queryChunks: jest.Mock; deleteByDocument: jest.Mock };
    let index: MemoryFactVectorIndexService;

    beforeEach(() => {
        ai = {
            embed: jest.fn().mockResolvedValue({ model: 'model-a', embeddings: [[0.1, 0.2, 0.3]] }),
        };
        plugin = {
            id: 'store-under-test',
            upsertChunks: jest.fn().mockResolvedValue({ written: 1, skipped: 0 }),
            isAvailable: jest.fn().mockResolvedValue(true),
        };
        facade = {
            select: jest.fn().mockResolvedValue(plugin),
            queryChunks: jest.fn().mockResolvedValue({ hits: [] }),
            deleteByDocument: jest.fn().mockResolvedValue(undefined),
        };
        index = new MemoryFactVectorIndexService(
            ai as unknown as AiFacadeService,
            facade as unknown as VectorStoreFacadeService,
        );
    });

    describe('namespaceFor', () => {
        it('is a deterministic UUID per workspace', () => {
            const a = index.namespaceFor(KEY);
            expect(a).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            expect(index.namespaceFor({ ...KEY })).toBe(a);
        });

        it('separates organizations, users and the personal workspace', () => {
            const orgA = index.namespaceFor(KEY);
            expect(index.namespaceFor({ ...KEY, organizationId: 'o-2' })).not.toBe(orgA);
            expect(index.namespaceFor({ ...KEY, userId: 'u-2' })).not.toBe(orgA);
            expect(index.namespaceFor({ ...KEY, organizationId: null })).not.toBe(orgA);
        });
    });

    it('writes one chunk per fact, keyed by the fact id, into the workspace namespace', async () => {
        const result = await index.upsert(
            KEY,
            { id: 'f-1', body: 'Invoices go out on the 1st.', scope: 'workspace', agentId: null },
            { vector: [0.1, 0.2, 0.3], model: 'model-a', dims: 3 },
        );

        const namespace = index.namespaceFor(KEY);
        expect(result).toEqual({ ok: true, value: { vectorStoreId: 'store-under-test' } });
        expect(facade.select).toHaveBeenCalledWith({ workId: namespace, userId: 'u-1' });
        const input = plugin.upsertChunks.mock.calls[0][0];
        expect(input.workId).toBe(namespace);
        expect(input.documentId).toBe('f-1');
        expect(input.chunks).toHaveLength(1);
        expect(input.chunks[0]).toMatchObject({
            id: 'f-1',
            workId: namespace,
            documentId: 'f-1',
            chunkIndex: 0,
            embedding: [0.1, 0.2, 0.3],
            organizationId: 'o-1',
            tenantId: 't-1',
        });
    });

    it('maps query hits back to fact ids with the normalized score', async () => {
        facade.queryChunks.mockResolvedValue({
            hits: [
                { chunk: { documentId: 'f-1' }, normalizedScore: 0.9, rawScore: 0.2, rank: 1 },
                { chunk: { documentId: '' }, normalizedScore: 0.8, rawScore: 0.4, rank: 2 },
            ],
        });

        const result = await index.query(KEY, { vector: [1], model: 'm', dims: 1 }, 50);

        expect(result).toEqual({ ok: true, value: [{ factId: 'f-1', normalizedScore: 0.9 }] });
        const namespace = index.namespaceFor(KEY);
        expect(facade.queryChunks).toHaveBeenCalledWith(
            { workId: namespace, queryEmbedding: [1], topK: 50 },
            { workId: namespace, userId: 'u-1' },
        );
    });

    it('degrades (never throws) when no vector store is configured', async () => {
        facade.select.mockRejectedValue(new VectorStoreNotConfiguredError('none'));
        const result = await index.upsert(
            KEY,
            { id: 'f-1', body: 'x', scope: 'workspace', agentId: null },
            { vector: [1], model: 'm', dims: 1 },
        );
        expect(result).toMatchObject({ ok: false, reason: 'not-configured' });
    });

    it('classifies an unwired store as unavailable', async () => {
        const unwired = Object.assign(new Error('repository not wired in'), {
            name: 'VectorStoreError',
            code: 'unavailable',
        });
        facade.queryChunks.mockRejectedValue(unwired);
        const result = await index.query(KEY, { vector: [1], model: 'm', dims: 1 }, 5);
        expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    });

    it('classifies any other vendor error as failed', async () => {
        facade.deleteByDocument.mockRejectedValue(new Error('500'));
        await expect(index.remove(KEY, 'f-1')).resolves.toMatchObject({
            ok: false,
            reason: 'failed',
        });
    });

    it('degrades when the AI provider cannot embed', async () => {
        ai.embed.mockRejectedValue(new Error('does not implement createEmbedding'));
        await expect(index.embed('hello', 'u-1')).resolves.toMatchObject({
            ok: false,
            reason: 'not-configured',
        });
    });

    it('reports availability without spending an embedding', async () => {
        await expect(index.isAvailable(KEY)).resolves.toBe(true);
        expect(ai.embed).not.toHaveBeenCalled();
        facade.select.mockRejectedValue(new VectorStoreNotConfiguredError('none'));
        await expect(index.isAvailable(KEY)).resolves.toBe(false);
    });

    it('is fully degraded when neither facade is wired', async () => {
        const bare = new MemoryFactVectorIndexService();
        await expect(bare.embed('x', 'u-1')).resolves.toMatchObject({ ok: false });
        await expect(bare.isAvailable(KEY)).resolves.toBe(false);
        await expect(
            bare.query(KEY, { vector: [1], model: 'm', dims: 1 }, 5),
        ).resolves.toMatchObject({
            ok: false,
        });
    });
});

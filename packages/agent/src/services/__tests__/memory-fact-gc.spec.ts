import { MemoryFactSweepService } from '../memory-fact-sweep.service';
import { MemoryFactEmbedService } from '../memory-fact-embed.service';
import type { MemoryFactRepository } from '../../database/repositories/memory-fact.repository';
import type { MemoryFactVectorIndexService } from '../memory-fact-vector-index.service';
import type { MemoryFact } from '../../entities/memory-fact.entity';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-14T04:13:00Z');

function fact(id: string, overrides: Partial<MemoryFact> = {}): MemoryFact {
    return {
        id,
        userId: 'u-1',
        organizationId: 'o-1',
        tenantId: 't-1',
        scope: 'workspace',
        agentId: null,
        body: `body ${id}`,
        status: 'active',
        origin: 'user',
        pinned: false,
        embeddedAt: null,
        embeddingModel: null,
        embeddingDims: null,
        vectorStoreId: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    } as MemoryFact;
}

describe('MemoryFactSweepService (memory-fact-gc)', () => {
    let repo: Record<string, jest.Mock>;
    let vectors: Record<string, jest.Mock>;
    let sweep: MemoryFactSweepService;

    beforeEach(() => {
        repo = {
            dueForPurge: jest.fn().mockResolvedValue([]),
            deleteByIds: jest.fn(async (ids: string[]) => ids.length),
            dueForEmbed: jest.fn().mockResolvedValue([]),
            dueForReembed: jest.fn().mockResolvedValue([]),
            findProbeCandidate: jest.fn().mockResolvedValue(null),
            markEmbedded: jest.fn().mockResolvedValue(true),
        };
        vectors = {
            embed: jest.fn().mockResolvedValue({
                ok: true,
                value: { vector: [0.1, 0.2], model: 'model-new', dims: 2 },
            }),
            upsert: jest.fn().mockResolvedValue({ ok: true, value: { vectorStoreId: 'store-a' } }),
            remove: jest.fn().mockResolvedValue({ ok: true, value: true }),
        };
        const embedder = new MemoryFactEmbedService(
            repo as unknown as MemoryFactRepository,
            vectors as unknown as MemoryFactVectorIndexService,
        );
        sweep = new MemoryFactSweepService(
            repo as unknown as MemoryFactRepository,
            embedder,
            vectors as unknown as MemoryFactVectorIndexService,
        );
    });

    it('purges facts forgotten more than 30 days ago — vector first, then the row', async () => {
        repo.dueForPurge.mockResolvedValueOnce([
            { id: 'f-old', userId: 'u-1', organizationId: 'o-1', vectorStoreId: 'store-a' },
            { id: 'f-never-embedded', userId: 'u-1', organizationId: null, vectorStoreId: null },
        ]);

        const summary = await sweep.sweep(NOW);

        const cutoff: Date = repo.dueForPurge.mock.calls[0][0];
        expect(NOW.getTime() - cutoff.getTime()).toBe(30 * DAY);
        expect(vectors.remove).toHaveBeenCalledTimes(1);
        expect(vectors.remove).toHaveBeenCalledWith(
            { userId: 'u-1', organizationId: 'o-1' },
            'f-old',
        );
        expect(repo.deleteByIds).toHaveBeenCalledWith(['f-old', 'f-never-embedded']);
        expect(summary.purged).toBe(2);
    });

    it('still deletes the row when the vector store cannot remove the vector', async () => {
        repo.dueForPurge.mockResolvedValueOnce([
            { id: 'f-old', userId: 'u-1', organizationId: 'o-1', vectorStoreId: 'store-gone' },
        ]);
        vectors.remove.mockResolvedValue({ ok: false, reason: 'not-configured', detail: 'gone' });

        const summary = await sweep.sweep(NOW);

        expect(summary.purged).toBe(1);
    });

    it('backfills never-embedded facts and stamps their coordinates', async () => {
        repo.dueForEmbed.mockResolvedValue([fact('f-1'), fact('f-2')]);

        const summary = await sweep.sweep(NOW);

        expect(summary.embedded).toBe(2);
        expect(repo.markEmbedded).toHaveBeenCalledWith(
            'f-1',
            'body f-1',
            expect.objectContaining({
                vectorStoreId: 'store-a',
                embeddingModel: 'model-new',
                embeddingDims: 2,
            }),
        );
    });

    it('stops at the first "no provider" answer instead of failing 500 times', async () => {
        repo.dueForEmbed.mockResolvedValue([fact('f-1'), fact('f-2'), fact('f-3')]);
        vectors.embed.mockResolvedValue({ ok: false, reason: 'not-configured', detail: 'no ai' });

        const summary = await sweep.sweep(NOW);

        expect(vectors.embed).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ embedded: 0, reembedded: 0, embedStoppedReason: 'no ai' });
        expect(repo.dueForReembed).not.toHaveBeenCalled();
    });

    it('re-embeds facts whose model drifted, using the model learned from the backfill', async () => {
        repo.dueForEmbed.mockResolvedValue([fact('f-new')]);
        repo.dueForReembed.mockResolvedValue([
            fact('f-stale', {
                embeddedAt: new Date('2026-01-01T00:00:00Z'),
                embeddingModel: 'model-old',
                embeddingDims: 2,
                vectorStoreId: 'store-a',
            }),
        ]);

        const summary = await sweep.sweep(NOW);

        expect(repo.dueForReembed).toHaveBeenCalledWith(
            { embeddingModel: 'model-new', embeddingDims: 2, vectorStoreId: 'store-a' },
            499,
        );
        expect(summary.reembedded).toBe(1);
    });

    it('learns the current model from one probe when nothing needed backfilling', async () => {
        repo.findProbeCandidate.mockResolvedValue(
            fact('f-probe', { embeddedAt: new Date(), embeddingModel: 'model-new' }),
        );

        await sweep.sweep(NOW);

        expect(vectors.embed).toHaveBeenCalledTimes(1);
        expect(repo.dueForReembed).toHaveBeenCalledWith(
            { embeddingModel: 'model-new', embeddingDims: 2, vectorStoreId: 'store-a' },
            500,
        );
    });

    it('is quiet and does nothing on an empty workspace', async () => {
        const summary = await sweep.sweep(NOW);
        expect(summary).toEqual({
            purged: 0,
            embedded: 0,
            reembedded: 0,
            embedStoppedReason: null,
        });
        expect(vectors.embed).not.toHaveBeenCalled();
    });
});

describe('MemoryFactEmbedService', () => {
    let repo: Record<string, jest.Mock>;
    let vectors: Record<string, jest.Mock>;
    let embedder: MemoryFactEmbedService;

    beforeEach(() => {
        repo = {
            findForEmbedding: jest.fn().mockResolvedValue(fact('f-1')),
            markEmbedded: jest.fn().mockResolvedValue(true),
        };
        vectors = {
            embed: jest.fn().mockResolvedValue({
                ok: true,
                value: { vector: [1, 0], model: 'model-a', dims: 2 },
            }),
            upsert: jest.fn().mockResolvedValue({ ok: true, value: { vectorStoreId: 'store-a' } }),
        };
        embedder = new MemoryFactEmbedService(
            repo as unknown as MemoryFactRepository,
            vectors as unknown as MemoryFactVectorIndexService,
        );
    });

    it('embeds through the facade and writes through the vector-store port', async () => {
        const outcome = await embedder.embedFact('f-1');

        expect(outcome).toMatchObject({ status: 'embedded', vectorStoreId: 'store-a' });
        expect(vectors.upsert).toHaveBeenCalledWith(
            { userId: 'u-1', organizationId: 'o-1', tenantId: 't-1' },
            { id: 'f-1', body: 'body f-1', scope: 'workspace', agentId: null },
            { vector: [1, 0], model: 'model-a', dims: 2 },
        );
    });

    it('is a no-op for an already-embedded fact (re-running the job spends nothing)', async () => {
        repo.findForEmbedding.mockResolvedValue(fact('f-1', { embeddedAt: new Date() }));
        const outcome = await embedder.embedFact('f-1');
        expect(outcome).toEqual({ status: 'skipped', factId: 'f-1', reason: 'already-embedded' });
        expect(vectors.embed).not.toHaveBeenCalled();
    });

    it('skips a missing or forgotten fact', async () => {
        repo.findForEmbedding.mockResolvedValueOnce(null);
        expect((await embedder.embedFact('f-x')).status).toBe('skipped');
        repo.findForEmbedding.mockResolvedValueOnce(fact('f-1', { status: 'forgotten' }));
        expect((await embedder.embedFact('f-1')).status).toBe('skipped');
        expect(vectors.embed).not.toHaveBeenCalled();
    });

    it('reports a stale body when an edit raced the embed', async () => {
        repo.markEmbedded.mockResolvedValue(false);
        const outcome = await embedder.embedFact('f-1');
        expect(outcome).toEqual({ status: 'skipped', factId: 'f-1', reason: 'stale-body' });
    });

    it('reports unavailable when the vector store refuses', async () => {
        vectors.upsert.mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'not wired' });
        const outcome = await embedder.embedFact('f-1');
        expect(outcome).toEqual({ status: 'unavailable', factId: 'f-1', reason: 'not wired' });
        expect(repo.markEmbedded).not.toHaveBeenCalled();
    });
});

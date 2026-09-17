import { MemoryFactSearchService, fuse } from '../memory-fact-search.service';
import type { MemoryFactRepository } from '../../database/repositories/memory-fact.repository';
import type { MemoryFactVectorIndexService } from '../memory-fact-vector-index.service';
import type { MemoryFact } from '../../entities/memory-fact.entity';

const ORG = { tenantId: 't-1', organizationId: 'o-1' };
const ACTOR = { userId: 'u-1', ownership: ORG };
const FILTER = { status: 'active' as const };

function fact(id: string, overrides: Partial<MemoryFact> = {}): MemoryFact {
    return {
        id,
        userId: 'u-1',
        organizationId: 'o-1',
        tenantId: 't-1',
        scope: 'workspace',
        agentId: null,
        body: `body of ${id}`,
        status: 'active',
        origin: 'user',
        pinned: false,
        embeddedAt: new Date('2026-09-14T00:00:00Z'),
        embeddingModel: 'model-a',
        embeddingDims: 3,
        createdAt: new Date('2026-09-14T00:00:00Z'),
        updatedAt: new Date('2026-09-14T00:00:00Z'),
        ...overrides,
    } as MemoryFact;
}

/** normalizedScore for a cosine, the way both shipped cosine stores report it. */
const n = (cosine: number) => (1 + cosine) / 2;

describe('MemoryFactSearchService', () => {
    let repo: { searchLiteral: jest.Mock; findOwnedByIds: jest.Mock };
    let vectors: { embed: jest.Mock; query: jest.Mock };
    let service: MemoryFactSearchService;

    beforeEach(() => {
        repo = {
            searchLiteral: jest.fn().mockResolvedValue([]),
            findOwnedByIds: jest.fn().mockResolvedValue([]),
        };
        vectors = {
            embed: jest.fn().mockResolvedValue({
                ok: true,
                value: { vector: [0.1, 0.2, 0.3], model: 'model-a', dims: 3 },
            }),
            query: jest.fn().mockResolvedValue({ ok: true, value: [] }),
        };
        service = new MemoryFactSearchService(
            repo as unknown as MemoryFactRepository,
            vectors as unknown as MemoryFactVectorIndexService,
        );
    });

    it('finds a fact by meaning even when it shares no word with the query', async () => {
        const delivery = fact('f-delivery', {
            body: 'We never quote a delivery date shorter than ten working days.',
        });
        vectors.query.mockResolvedValue({
            ok: true,
            value: [{ factId: 'f-delivery', normalizedScore: n(0.81) }],
        });
        repo.findOwnedByIds.mockResolvedValue([delivery]);

        const result = await service.search(ACTOR, 'promises to customers', FILTER);

        expect(result.semantic).toBe(true);
        expect(result.results).toHaveLength(1);
        expect(result.results[0].fact.id).toBe('f-delivery');
        expect(result.results[0].score).toBeCloseTo(0.81, 5);
        expect(result.results[0].literalMatch).toBe(false);
        // The workspace key the vector namespace is derived from.
        expect(vectors.query).toHaveBeenCalledWith(
            { userId: 'u-1', organizationId: 'o-1', tenantId: 't-1' },
            expect.anything(),
            50,
        );
    });

    it('applies the 0.55 cosine threshold on the normalized scale', async () => {
        vectors.query.mockResolvedValue({
            ok: true,
            value: [
                { factId: 'f-close', normalizedScore: n(0.56) },
                { factId: 'f-far', normalizedScore: n(0.54) },
            ],
        });
        repo.findOwnedByIds.mockResolvedValue([fact('f-close')]);

        const result = await service.search(ACTOR, 'query', FILTER);

        expect(repo.findOwnedByIds).toHaveBeenCalledWith(['f-close'], 'u-1', ORG);
        expect(result.results.map((r) => r.fact.id)).toEqual(['f-close']);
    });

    it('always includes every literal hit, even one the vector store scored low', async () => {
        const literalOnly = fact('f-literal', { body: 'refund policy is 14 days' });
        repo.searchLiteral.mockResolvedValue([literalOnly]);
        vectors.query.mockResolvedValue({
            ok: true,
            value: [
                { factId: 'f-literal', normalizedScore: n(0.1) },
                { factId: 'f-semantic', normalizedScore: n(0.9) },
            ],
        });
        repo.findOwnedByIds.mockResolvedValue([fact('f-semantic')]);

        const result = await service.search(ACTOR, 'refund', FILTER);

        const ids = result.results.map((r) => r.fact.id);
        expect(ids).toEqual(['f-semantic', 'f-literal']);
        expect(result.results[1]).toMatchObject({ literalMatch: true, score: null });
    });

    it('drops a vector hit the database does not return under the caller’s ownership', async () => {
        vectors.query.mockResolvedValue({
            ok: true,
            value: [{ factId: 'f-other-workspace', normalizedScore: n(0.95) }],
        });
        repo.findOwnedByIds.mockResolvedValue([]);

        const result = await service.search(ACTOR, 'anything', FILTER);

        expect(result.results).toEqual([]);
        expect(result.semantic).toBe(true);
    });

    it('drops a hit embedded by a different model than the query', async () => {
        vectors.query.mockResolvedValue({
            ok: true,
            value: [{ factId: 'f-old', normalizedScore: n(0.9) }],
        });
        repo.findOwnedByIds.mockResolvedValue([fact('f-old', { embeddingModel: 'model-old' })]);

        const result = await service.search(ACTOR, 'anything', FILTER);

        expect(result.results).toEqual([]);
    });

    it('drops a hit outside the active filter', async () => {
        vectors.query.mockResolvedValue({
            ok: true,
            value: [{ factId: 'f-forgotten', normalizedScore: n(0.9) }],
        });
        repo.findOwnedByIds.mockResolvedValue([fact('f-forgotten', { status: 'forgotten' })]);

        const result = await service.search(ACTOR, 'anything', FILTER);

        expect(result.results).toEqual([]);
    });

    it('degrades to literal matching with semantic: false when no provider can embed', async () => {
        vectors.embed.mockResolvedValue({ ok: false, reason: 'not-configured', detail: 'none' });
        repo.searchLiteral.mockResolvedValue([fact('f-1')]);

        const result = await service.search(ACTOR, 'body', FILTER);

        expect(result.semantic).toBe(false);
        expect(result.results.map((r) => r.fact.id)).toEqual(['f-1']);
        expect(vectors.query).not.toHaveBeenCalled();
    });

    it('degrades when the vector store is unavailable', async () => {
        vectors.query.mockResolvedValue({ ok: false, reason: 'unavailable', detail: 'not wired' });
        repo.searchLiteral.mockResolvedValue([fact('f-1')]);

        const result = await service.search(ACTOR, 'body', FILTER);

        expect(result).toEqual({
            results: [
                { fact: expect.objectContaining({ id: 'f-1' }), score: null, literalMatch: true },
            ],
            semantic: false,
        });
    });

    it('degrades instead of throwing when the AI facade itself throws', async () => {
        vectors.embed.mockRejectedValue(new Error('boom'));
        repo.searchLiteral.mockResolvedValue([fact('f-1')]);

        await expect(service.search(ACTOR, 'body', FILTER)).resolves.toMatchObject({
            semantic: false,
        });
    });

    it('returns nothing for a blank query without touching storage', async () => {
        const result = await service.search(ACTOR, '   ', FILTER);
        expect(result).toEqual({ results: [], semantic: false });
        expect(repo.searchLiteral).not.toHaveBeenCalled();
    });
});

describe('fuse', () => {
    it('caps at 50 but never evicts a literal hit', () => {
        const literal = Array.from({ length: 10 }, (_, i) => fact(`l-${i}`));
        const semantic = Array.from({ length: 60 }, (_, i) => ({
            fact: fact(`s-${i}`),
            score: 0.99 - i * 0.001,
        }));

        const fused = fuse(literal, semantic);

        expect(fused).toHaveLength(50);
        for (const hit of literal) {
            expect(fused.map((f) => f.fact.id)).toContain(hit.id);
        }
    });

    it('keeps 50 literal hits even with no room for semantic ones', () => {
        const literal = Array.from({ length: 50 }, (_, i) => fact(`l-${i}`));
        const fused = fuse(literal, [{ fact: fact('s-1'), score: 0.99 }]);
        expect(fused).toHaveLength(50);
        expect(fused.every((f) => f.literalMatch)).toBe(true);
    });

    it('credits a hit that is both literal and semantic with its semantic score', () => {
        const both = fact('f-both');
        const fused = fuse([both], [{ fact: both, score: 0.7 }]);
        expect(fused).toEqual([{ fact: both, score: 0.7, literalMatch: true }]);
    });
});

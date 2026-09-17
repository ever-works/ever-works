import { DataSource, Repository } from 'typeorm';
import { MemoryFact } from '../../entities/memory-fact.entity';
import { MemoryFactRepository } from '../../database/repositories/memory-fact.repository';
import { MemoryFactEmbedService } from '../memory-fact-embed.service';
import { MemoryFactSweepService } from '../memory-fact-sweep.service';
import type { MemoryFactVectorIndexService } from '../memory-fact-vector-index.service';

/**
 * AW-07 — embedding drift is decided per provider-selection scope.
 *
 * The AI provider is resolved per owner, so two owners can legitimately
 * embed with two different models on the same night. A sweep that learns ONE
 * model and compares every workspace's facts against it re-embeds facts that
 * already match their own provider — every night, spending the budget that
 * genuinely stale facts are waiting for. Real SQL (better-sqlite3), the real
 * repository, the real embed service; only the provider is simulated.
 */
describe('MemoryFactSweepService drift scoping (integration)', () => {
    let dataSource: DataSource;
    let repo: Repository<MemoryFact>;
    let facts: MemoryFactRepository;
    let sweep: MemoryFactSweepService;
    let embed: jest.Mock;

    const USER_A = '55555555-5555-4555-8555-555555555555';
    const USER_B = '66666666-6666-4666-8666-666666666666';
    const ORG = '22222222-2222-4222-8222-222222222222';
    const NOW = new Date('2026-09-14T04:13:00Z');

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [MemoryFact],
            synchronize: true,
        });
        await dataSource.initialize();
        repo = dataSource.getRepository(MemoryFact);
        facts = new MemoryFactRepository(repo);
        // Owner A's provider embeds with model-a, owner B's with model-b.
        embed = jest.fn(async (_text: string, userId: string) => ({
            ok: true,
            value: {
                vector: [0.1, 0.2, 0.3],
                model: userId === USER_A ? 'model-a' : 'model-b',
                dims: 3,
            },
        }));
        const vectors = {
            embed,
            upsert: jest.fn(async () => ({ ok: true, value: { vectorStoreId: 'store-1' } })),
            remove: jest.fn(async () => ({ ok: true, value: true })),
        } as unknown as MemoryFactVectorIndexService;
        const embedder = new MemoryFactEmbedService(facts, vectors);
        sweep = new MemoryFactSweepService(facts, embedder, vectors);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function embeddedFact(
        userId: string,
        body: string,
        model: string,
        embeddedAt: string,
    ): Promise<MemoryFact> {
        const row = await repo.save(
            repo.create({
                userId,
                tenantId: null,
                organizationId: ORG,
                body,
                status: 'active',
                origin: 'user',
                scope: 'workspace',
                agentId: null,
                pinned: false,
                vectorStoreId: 'store-1',
                embeddingModel: model,
                embeddingDims: 3,
                embeddedAt: new Date(embeddedAt),
            }),
        );
        return row;
    }

    it("does not re-embed a fact that already matches its own owner's provider", async () => {
        await embeddedFact(USER_A, 'fact of A', 'model-a', '2026-09-01T00:00:00Z');
        const ofB = await embeddedFact(USER_B, 'fact of B', 'model-b', '2026-09-02T00:00:00Z');

        const summary = await sweep.sweep(NOW);

        expect(summary.reembedded).toBe(0);
        const storedB = await repo.findOneByOrFail({ id: ofB.id });
        expect(storedB.embeddingModel).toBe('model-b');
    });

    it("still re-embeds a fact that drifted from its own owner's provider", async () => {
        await embeddedFact(USER_A, 'fact of A', 'model-a', '2026-09-01T00:00:00Z');
        await embeddedFact(USER_B, 'current fact of B', 'model-b', '2026-09-02T00:00:00Z');
        const stale = await embeddedFact(
            USER_B,
            'stale fact of B',
            'model-old',
            '2026-09-03T00:00:00Z',
        );

        const summary = await sweep.sweep(NOW);

        expect(summary.reembedded).toBe(1);
        expect((await repo.findOneByOrFail({ id: stale.id })).embeddingModel).toBe('model-b');
        // One probe per scope, plus the one genuinely stale fact.
        expect(embed).toHaveBeenCalledTimes(3);
    });
});

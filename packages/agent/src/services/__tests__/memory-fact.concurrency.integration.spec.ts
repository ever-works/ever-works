import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { MEMORY_FACT_ACTIVE_MAX, MEMORY_FACT_PINNED_MAX } from '@ever-works/contracts';
import { MemoryFact } from '../../entities/memory-fact.entity';
import { MemoryFactRepository } from '../../database/repositories/memory-fact.repository';
import type { OwnershipScope } from '../../database/ownership-scope';
import { MemoryFactService } from '../memory-fact.service';
import type { MemoryFactSearchService } from '../memory-fact-search.service';

/**
 * AW-07 — the workspace caps and the duplicate defence under concurrency,
 * against a REAL SQL engine (better-sqlite3) and the real repository.
 *
 * Every check is a read followed by a write. Two requests that both read
 * before either writes would both pass — two copies of one fact, or 2,001
 * active facts. These tests start both requests before either can finish
 * and assert the database never ends up past an invariant.
 */
describe('MemoryFactService under concurrent writes (integration)', () => {
    let dataSource: DataSource;
    let repo: Repository<MemoryFact>;
    let facts: MemoryFactRepository;
    let service: MemoryFactService;

    const USER = '44444444-4444-4444-8444-444444444444';
    const ORG_A: OwnershipScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const ORG_B: OwnershipScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '33333333-3333-4333-8333-333333333333',
    };
    const actorIn = (ownership: OwnershipScope) => ({ userId: USER, ownership });

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
        service = new MemoryFactService(facts, {} as MemoryFactSearchService);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function seed(
        count: number,
        ownership: OwnershipScope,
        overrides: Partial<MemoryFact> = {},
    ): Promise<void> {
        const rows = Array.from({ length: count }, (_, index) => ({
            userId: USER,
            tenantId: ownership.tenantId,
            organizationId: ownership.organizationId,
            body: `seeded fact ${index}`,
            status: 'active' as const,
            origin: 'user' as const,
            scope: 'workspace' as const,
            agentId: null,
            pinned: false,
            ...overrides,
        }));
        for (let start = 0; start < rows.length; start += 40) {
            await repo.insert(rows.slice(start, start + 40));
        }
    }

    function codeOf(result: PromiseSettledResult<unknown>): string | null {
        if (result.status !== 'rejected') return null;
        const error = result.reason;
        if (!(error instanceof ConflictException)) return String(error);
        return (error.getResponse() as { code?: string }).code ?? null;
    }

    it('lets only one of two simultaneous identical facts in', async () => {
        const results = await Promise.allSettled([
            service.create(actorIn(ORG_A), { body: 'Invoices go out on the 1st.' }),
            service.create(actorIn(ORG_A), { body: 'invoices go out on the 1st.' }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.map(codeOf).filter(Boolean)).toEqual(['memory_fact_duplicate']);
        expect(await repo.count()).toBe(1);
    });

    it('never goes past the active-fact capacity when two creates race for the last slot', async () => {
        await seed(MEMORY_FACT_ACTIVE_MAX - 1, ORG_A);

        const results = await Promise.allSettled([
            service.create(actorIn(ORG_A), { body: 'one more fact' }),
            service.create(actorIn(ORG_A), { body: 'and another fact' }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.map(codeOf).filter(Boolean)).toEqual(['memory_fact_capacity_full']);
        expect((await facts.countByStatus(USER, ORG_A)).active).toBe(MEMORY_FACT_ACTIVE_MAX);
    });

    it('never goes past the pin cap when two pins race for the last slot', async () => {
        await seed(MEMORY_FACT_PINNED_MAX - 1, ORG_A, { pinned: true });
        const first = await service.create(actorIn(ORG_A), { body: 'unpinned one' });
        const second = await service.create(actorIn(ORG_A), { body: 'unpinned two' });

        const results = await Promise.allSettled([
            service.update(actorIn(ORG_A), first.id, { pinned: true }),
            service.update(actorIn(ORG_A), second.id, { pinned: true }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.map(codeOf).filter(Boolean)).toEqual(['memory_fact_pins_full']);
        expect((await facts.countByStatus(USER, ORG_A)).pinned).toBe(MEMORY_FACT_PINNED_MAX);
    });

    it('does not let a restore and a create revive the same body twice', async () => {
        const original = await service.create(actorIn(ORG_A), { body: 'Escalate over 2,000' });
        await service.forget(actorIn(ORG_A), original.id);

        const results = await Promise.allSettled([
            service.restore(actorIn(ORG_A), original.id),
            service.create(actorIn(ORG_A), { body: 'escalate over 2,000' }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.map(codeOf).filter(Boolean)).toEqual(['memory_fact_duplicate']);
        const counts = await facts.countByStatus(USER, ORG_A);
        expect(counts.active + counts.proposed).toBe(1);
    });

    it('serializes per workspace only — a write held in one workspace never delays another', async () => {
        let release: () => void = () => undefined;
        const held = facts.withWorkspaceWriteLock(
            USER,
            ORG_A,
            () => new Promise<void>((resolve) => (release = resolve)),
        );

        // Org B writes straight through while org A's lock is still held.
        const inB = await service.create(actorIn(ORG_B), { body: 'Org B fact' });
        expect(inB.status).toBe('active');

        // Org A's next write waits for the held one.
        let createdInA = false;
        const inA = service
            .create(actorIn(ORG_A), { body: 'Org A fact' })
            .then(() => (createdInA = true));
        await new Promise((resolve) => setImmediate(resolve));
        expect(createdInA).toBe(false);

        release();
        await held;
        await inA;
        expect(createdInA).toBe(true);
    });

    it('releases the lock when the guarded write is refused', async () => {
        await service.create(actorIn(ORG_A), { body: 'already here' });
        await expect(
            service.create(actorIn(ORG_A), { body: 'ALREADY HERE' }),
        ).rejects.toBeInstanceOf(ConflictException);

        // A refusal inside the lock must not wedge the workspace.
        await expect(
            service.create(actorIn(ORG_A), { body: 'something new' }),
        ).resolves.toMatchObject({ status: 'active' });
    });
});

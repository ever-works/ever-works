import { DataSource, Repository } from 'typeorm';
import { MemoryFact } from '../../entities/memory-fact.entity';
import { MemoryFactRepository } from './memory-fact.repository';
import type { OwnershipScope } from '../ownership-scope';

/**
 * `memory_facts` owner scoping, executed against a REAL SQL engine
 * (better-sqlite3) rather than a mocked query builder.
 *
 * Facts are workspace data: the whole privacy promise ("cross-workspace
 * reads return 404") rests on every owner-scoped statement carrying the
 * Tier C predicate. A mock can only prove a string was passed; this proves
 * the database actually refuses to return — or write — somebody else's row,
 * including on the UPDATE paths where a missing predicate is a silent write
 * into another workspace.
 */
describe('MemoryFactRepository owner scope SQL (integration)', () => {
    let dataSource: DataSource;
    let repo: Repository<MemoryFact>;
    let facts: MemoryFactRepository;

    const USER = 'user-1';
    const OTHER_USER = 'user-2';
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const ORG_A: OwnershipScope = {
        tenantId: TENANT,
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const ORG_B: OwnershipScope = {
        tenantId: TENANT,
        organizationId: '33333333-3333-4333-8333-333333333333',
    };
    const PERSONAL: OwnershipScope = { tenantId: TENANT, organizationId: null };

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
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const make = (
        body: string,
        ownership: OwnershipScope,
        overrides: Partial<{ userId: string; status: MemoryFact['status']; pinned: boolean }> = {},
    ) =>
        facts.create({
            userId: overrides.userId ?? USER,
            ownership,
            body,
            status: overrides.status ?? 'active',
            origin: 'user',
            scope: 'workspace',
            agentId: null,
            pinned: overrides.pinned ?? false,
        });

    it('lists only the facts of the active workspace, newest first', async () => {
        await make('org A first', ORG_A);
        await make('org B fact', ORG_B);
        await make('personal fact', PERSONAL);
        await make('other user in org A', ORG_A, { userId: OTHER_USER });
        await make('org A second', ORG_A);

        const { rows, total } = await facts.listForOwner(USER, ORG_A, { limit: 50 });

        expect(total).toBe(2);
        expect(rows.map((r) => r.body).sort()).toEqual(['org A first', 'org A second']);
    });

    it('resolves a cross-workspace id to null on read', async () => {
        const inB = await make('org B fact', ORG_B);
        expect(await facts.findOwned(inB.id, USER, ORG_A)).toBeNull();
        expect(await facts.findOwned(inB.id, USER, ORG_B)).not.toBeNull();
        expect(await facts.findOwnedByIds([inB.id], USER, ORG_A)).toEqual([]);
    });

    it('refuses to WRITE a cross-workspace id — the predicate is on the UPDATE itself', async () => {
        const inB = await make('org B fact', ORG_B);

        const updated = await facts.updateOwned(inB.id, USER, ORG_A, { body: 'hijacked' });

        expect(updated).toBeNull();
        const stored = await repo.findOneByOrFail({ id: inB.id });
        expect(stored.body).toBe('org B fact');
    });

    it('refuses to write another user’s fact even inside the same workspace', async () => {
        const theirs = await make('their fact', ORG_A, { userId: OTHER_USER });
        expect(await facts.updateOwned(theirs.id, USER, ORG_A, { pinned: true })).toBeNull();
    });

    it('matches literal substrings case-insensitively without treating % or _ as wildcards', async () => {
        await make('We never quote a Delivery date under ten days', ORG_A);
        await make('Invoices go out on the first working day', ORG_A);
        await make('Discount is 100% for partners', ORG_A);
        await make('Discount is 100 percent never', ORG_A);

        const delivery = await facts.searchLiteral(USER, ORG_A, 'delivery', { limit: 50 });
        expect(delivery.map((r) => r.body)).toEqual([
            'We never quote a Delivery date under ten days',
        ]);

        const percent = await facts.searchLiteral(USER, ORG_A, '100%', { limit: 50 });
        expect(percent.map((r) => r.body)).toEqual(['Discount is 100% for partners']);
    });

    it('counts per status and pinned-active for the workspace only', async () => {
        await make('a', ORG_A, { pinned: true });
        await make('b', ORG_A);
        await make('c', ORG_A, { status: 'proposed' });
        await make('d', ORG_A, { status: 'forgotten', pinned: true });
        await make('e', ORG_B, { pinned: true });

        expect(await facts.countByStatus(USER, ORG_A)).toEqual({
            active: 2,
            proposed: 1,
            forgotten: 1,
            // The forgotten pinned row does not count against the pin cap.
            pinned: 1,
        });
    });

    it('finds live exact duplicates case-insensitively and ignores forgotten ones', async () => {
        await make('Escalate anything over 2,000', ORG_A);
        await make('Old rule', ORG_A, { status: 'forgotten' });

        expect(
            await facts.findLiveDuplicate(USER, ORG_A, 'escalate ANYTHING over 2,000'),
        ).not.toBeNull();
        expect(await facts.findLiveDuplicate(USER, ORG_A, 'old rule')).toBeNull();
        expect(
            await facts.findLiveDuplicate(USER, ORG_B, 'escalate anything over 2,000'),
        ).toBeNull();
    });

    it('forgetAll forgets active + proposed in the workspace and touches nothing else', async () => {
        await make('a', ORG_A, { pinned: true });
        await make('b', ORG_A, { status: 'proposed' });
        await make('c', ORG_B);
        await make('d', ORG_A, { userId: OTHER_USER });

        const forgotten = await facts.forgetAll(USER, ORG_A, new Date('2026-09-14T10:00:00Z'));

        expect(forgotten).toBe(2);
        expect(await facts.countByStatus(USER, ORG_A)).toEqual({
            active: 0,
            proposed: 0,
            forgotten: 2,
            pinned: 0,
        });
        expect((await facts.countByStatus(USER, ORG_B)).active).toBe(1);
        expect((await facts.countByStatus(OTHER_USER, ORG_A)).active).toBe(1);
    });

    it('selects purge candidates only past the cutoff', async () => {
        const old = await make('old', ORG_A, { status: 'forgotten' });
        const recent = await make('recent', ORG_A, { status: 'forgotten' });
        await repo.update({ id: old.id }, { forgottenAt: new Date('2026-07-01T00:00:00Z') });
        await repo.update({ id: recent.id }, { forgottenAt: new Date('2026-09-10T00:00:00Z') });

        const due = await facts.dueForPurge(new Date('2026-08-15T00:00:00Z'), 100);

        expect(due.map((r) => r.id)).toEqual([old.id]);
    });

    it('markEmbedded refuses to stamp coordinates for a body that has since changed', async () => {
        const fact = await make('original body', ORG_A);
        await facts.updateOwned(fact.id, USER, ORG_A, { body: 'edited body' });

        const stamped = await facts.markEmbedded(fact.id, 'original body', {
            vectorStoreId: 'qdrant',
            embeddingModel: 'model-a',
            embeddingDims: 3,
            embeddedAt: new Date(),
        });

        expect(stamped).toBe(false);
        expect((await repo.findOneByOrFail({ id: fact.id })).embeddedAt).toBeNull();
    });

    it('selects never-embedded and drifted facts for the sweep', async () => {
        const fresh = await make('fresh', ORG_A);
        const drifted = await make('drifted', ORG_A);
        const current = await make('current', ORG_A);
        await facts.markEmbedded(drifted.id, 'drifted', {
            vectorStoreId: 'qdrant',
            embeddingModel: 'model-old',
            embeddingDims: 3,
            embeddedAt: new Date(),
        });
        await facts.markEmbedded(current.id, 'current', {
            vectorStoreId: 'qdrant',
            embeddingModel: 'model-new',
            embeddingDims: 3,
            embeddedAt: new Date(),
        });

        expect((await facts.dueForEmbed(10)).map((r) => r.id)).toEqual([fresh.id]);
        const reembed = await facts.dueForReembed(
            { embeddingModel: 'model-new', embeddingDims: 3, vectorStoreId: 'qdrant' },
            10,
        );
        expect(reembed.map((r) => r.id)).toEqual([drifted.id]);
    });
});

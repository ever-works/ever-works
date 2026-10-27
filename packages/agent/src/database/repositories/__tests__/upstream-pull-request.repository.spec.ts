import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../_entities-inventory';
import { UpstreamPullRequest } from '../../../entities/upstream-pull-request.entity';
import { UpstreamPullRequestRepository } from '../upstream-pull-request.repository';

/**
 * APW-09 T7 — `UpstreamPullRequestRepository` against a real better-sqlite3 schema built from
 * the whole entity inventory (the entity's relations reach most of it), so the decorators,
 * the partial unique index and the queries are proven together:
 *
 * - a second ACTIVE record for one source Task is refused and answers the holder's id; a
 *   final one does not hold the slot (FR-5, S27, ACC-09-34);
 * - every read is keyed by the App Work: another Work's record id answers `null`;
 * - the compare-and-set moves a record only from the states it names;
 * - the FR-26 / FR-39 windows count `openedAt` inside the window and nothing outside it,
 *   case-insensitively on the upstream coordinates.
 *
 * Foreign keys are switched off: seeding a valid user / Work graph would dwarf what is under
 * test, and the migration spec proves the cascades.
 */
describe('UpstreamPullRequestRepository (integration)', () => {
    let dataSource: DataSource;
    let rows: Repository<UpstreamPullRequest>;
    let repository: UpstreamPullRequestRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        rows = dataSource.getRepository(UpstreamPullRequest);
        repository = new UpstreamPullRequestRepository(rows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
    });

    let seq = 0;
    function base(overrides: Partial<UpstreamPullRequest> = {}) {
        seq += 1;
        return {
            userId: 'u1',
            workId: 'w1',
            sourceTaskId: `t${seq}`,
            upstreamOwner: 'acme',
            upstreamRepo: 'bookings',
            baseBranch: 'main',
            headOwner: 'maya',
            headRepo: 'bookings',
            headBranch: `upstream-pr/change-${seq}`,
            state: 'open' as const,
            ...overrides,
        };
    }

    it('claims a source Task once while active, and answers the holder on a second claim', async () => {
        const first = await repository.insertActive(
            base({ sourceTaskId: 't-a', state: 'opening' }),
        );
        expect(first.inserted).toBe(true);
        const second = await repository.insertActive(
            base({ sourceTaskId: 't-a', state: 'preparing' }),
        );
        expect(second).toEqual({ inserted: false, row: null, activeId: first.row?.id });
    });

    it('lets a final record and a NULL source coexist with an active one', async () => {
        await repository.insertActive(base({ sourceTaskId: 't-b', state: 'merged' }));
        await repository.insertActive(base({ sourceTaskId: 't-b', state: 'refused' }));
        const active = await repository.insertActive(base({ sourceTaskId: 't-b', state: 'open' }));
        expect(active.inserted).toBe(true);
        const a = await repository.insertActive(base({ sourceTaskId: null, state: 'open' }));
        const b = await repository.insertActive(base({ sourceTaskId: null, state: 'open' }));
        expect(a.inserted && b.inserted).toBe(true);
        expect(await rows.count()).toBe(5);
    });

    it('reads a record only through its own App Work', async () => {
        const result = await repository.insertActive(base({ workId: 'w1' }));
        if (!result.row) throw new Error('setup');
        expect((await repository.findForWork('w1', result.row.id))?.id).toBe(result.row.id);
        expect(await repository.findForWork('w2', result.row.id)).toBeNull();
    });

    it('defaults origin, draft, maintainerCanModify and reads preparationPausedMs as a number', async () => {
        const result = await repository.insertActive(base({ state: 'preparing' }));
        if (!result.row) throw new Error('setup');
        const row = await repository.findForWork('w1', result.row.id);
        expect(row?.origin).toBe('proposal');
        expect(row?.draft).toBe(false);
        expect(row?.maintainerCanModify).toBe(true);
        expect(row?.preparationPausedMs).toBe(0);
    });

    it('compare-and-sets a state change only from the states it names, and only on its Work', async () => {
        const result = await repository.insertActive(base({ state: 'awaiting_approval' }));
        if (!result.row) throw new Error('setup');
        const id = result.row.id;
        expect(await repository.updateStateIf(id, 'w1', ['open'], 'closed')).toBe(false);
        expect(await repository.updateStateIf(id, 'w2', ['awaiting_approval'], 'withdrawn')).toBe(
            false,
        );
        expect(
            await repository.updateStateIf(id, 'w1', ['awaiting_approval'], 'withdrawn', {
                forkBranchDeletedAt: null,
            }),
        ).toBe(true);
        expect((await repository.findForWork('w1', id))?.state).toBe('withdrawn');
        // A second writer loses: the record already left the state it expected.
        expect(await repository.updateStateIf(id, 'w1', ['awaiting_approval'], 'withdrawn')).toBe(
            false,
        );
    });

    it('lists every member’s records for the Work, newest first, filtered and clamped', async () => {
        await repository.insertActive(base({ userId: 'u1', state: 'open' }));
        await repository.insertActive(base({ userId: 'u2', state: 'merged' }));
        await repository.insertActive(base({ workId: 'w2', state: 'open' }));
        const all = await repository.listForWork('w1');
        expect(all.total).toBe(2);
        expect(new Set(all.rows.map((row) => row.userId))).toEqual(new Set(['u1', 'u2']));
        const merged = await repository.listForWork('w1', { state: 'merged' });
        expect(merged.rows.map((row) => row.state)).toEqual(['merged']);
        const one = await repository.listForWork('w1', { limit: 0 });
        expect(one.rows).toHaveLength(1);
    });

    it('counts the FR-26 / FR-39 windows on openedAt, case-insensitively, and nothing outside them', async () => {
        const now = Date.now();
        const hour = 3_600_000;
        await repository.insertActive(base({ userId: 'u1', openedAt: new Date(now - 2 * hour) }));
        await repository.insertActive(
            base({
                userId: 'u1',
                upstreamOwner: 'ACME',
                upstreamRepo: 'Bookings',
                openedAt: new Date(now - hour),
            }),
        );
        // Outside the window.
        await repository.insertActive(base({ userId: 'u1', openedAt: new Date(now - 25 * hour) }));
        // Another upstream, same member.
        await repository.insertActive(
            base({
                userId: 'u1',
                upstreamOwner: 'other',
                upstreamRepo: 'thing',
                openedAt: new Date(now - hour),
            }),
        );
        // Another member, same upstream.
        await repository.insertActive(base({ userId: 'u2', openedAt: new Date(now - hour) }));
        // Never opened.
        await repository.insertActive(base({ userId: 'u1', state: 'preparing', openedAt: null }));

        const since = new Date(now - 24 * hour);
        expect(await repository.countOpenedByUserOnUpstream('u1', 'acme', 'bookings', since)).toBe(
            2,
        );
        expect(await repository.countOpenedByUser('u1', since)).toBe(3);
        expect(await repository.countOpenedOnUpstream('Acme', 'BOOKINGS', since)).toBe(3);
        const window = await repository.openedAtInWindow(
            { userId: 'u1', upstreamOwner: 'acme', upstreamRepo: 'bookings' },
            since,
            10,
        );
        expect(window.map((date) => date.getTime())).toEqual([now - 2 * hour, now - hour]);
    });

    it('counts the open-at-once and preparing caps', async () => {
        await repository.insertActive(base({ userId: 'u1', state: 'open' }));
        await repository.insertActive(base({ userId: 'u1', state: 'opening' }));
        await repository.insertActive(base({ userId: 'u1', state: 'merged' }));
        await repository.insertActive(base({ userId: 'u1', state: 'preparing' }));
        expect(await repository.countOpenByUserOnUpstream('u1', 'acme', 'bookings')).toBe(2);
        expect(await repository.countPreparingOnWork('w1')).toBe(1);
        expect(await repository.countPreparingOnWork('w2')).toBe(0);
    });
});

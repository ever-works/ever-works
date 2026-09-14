import { DataSource, In } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository } from './agent-run.repository';

/**
 * Time-ordered `agent_runs` reads when several runs share one `createdAt`.
 *
 * On better-sqlite3 `createdAt` defaults to `datetime('now')`: TEXT with
 * whole-second resolution, so a burst of runs inserted inside one second
 * ties. SQLite returns tied rows in index order — for most plans the OLDEST
 * inserted row first — so an `ORDER BY createdAt DESC` "latest" read picked
 * the wrong run. These specs seed real ties and pin every reader to
 * insertion order.
 *
 * A seeded burst gets ids in REVERSE lexical order of insertion by default,
 * and in lexical order of insertion with `ascendingIds`. Readers are
 * exercised under both, so an id tie-break (deterministic, but not
 * chronological for uuid v4 ids) fails here in EITHER direction, just like
 * no tie-break at all.
 */
describe('AgentRunRepository — same-second ties follow insertion order (integration)', () => {
    let dataSource: DataSource;
    let runs: AgentRunRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const TASK = '77777777-7777-4777-8777-777777777777';
    const OTHER_TASK = '88888888-8888-4888-8888-888888888888';

    /** One wall-clock second every tied row shares. */
    const SAME_SECOND = new Date('2026-09-14T10:00:00.000Z');
    /** The same instant in `datetime('now')`'s own TEXT shape. */
    const SAME_SECOND_TEXT = '2026-09-14 10:00:00';
    const LATER = new Date('2026-09-14T10:05:00.000Z');
    const WINDOW = {
        from: new Date('2026-09-14T00:00:00.000Z'),
        to: new Date('2026-09-15T00:00:00.000Z'),
    };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        // Read-model specs: no parent rows are seeded.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        runs = new AgentRunRepository(dataSource.getRepository(AgentRun));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(AgentRun).clear();
        burst = 0;
    });

    /** Id prefixes, descending: the first row of a burst gets the largest id. */
    const PREFIXES = ['f', 'e', 'd', 'c', 'b', 'a', '9', '8'];
    let burst = 0;

    /**
     * Insert rows one after another, all with one `createdAt`, ids in
     * reverse lexical order of insertion — or in lexical order of insertion
     * with `ascendingIds`. `text` rewrites the shared stamp as raw
     * `'YYYY-MM-DD HH:MM:SS'` TEXT — what the column default writes.
     */
    async function seedBurst(
        rows: Array<Partial<AgentRun>>,
        options: { text?: boolean; ascendingIds?: boolean } = {},
    ): Promise<AgentRun[]> {
        burst += 1;
        const repository = dataSource.getRepository(AgentRun);
        const saved: AgentRun[] = [];
        for (const [index, overrides] of rows.entries()) {
            const prefixIndex = options.ascendingIds ? PREFIXES.length - 1 - index : index;
            const prefix = PREFIXES[prefixIndex].repeat(8);
            saved.push(
                await repository.save(
                    repository.create({
                        id: `${prefix}-0000-4000-8000-${String(burst).padStart(12, '0')}`,
                        userId: USER,
                        agentId: AGENT_A,
                        taskId: TASK,
                        triggerKind: 'task',
                        status: 'completed',
                        gateAttempts: 0,
                        persistent: false,
                        awaitingInput: false,
                        interruptRequested: false,
                        startedAt: SAME_SECOND,
                        createdAt: SAME_SECOND,
                        ...overrides,
                    } as Partial<AgentRun>),
                ),
            );
        }
        if (options.text) {
            await dataSource.query(
                `UPDATE agent_runs SET "createdAt" = ? WHERE id IN (${saved.map(() => '?').join(', ')})`,
                [SAME_SECOND_TEXT, ...saved.map((row) => row.id)],
            );
        }
        const stamps = await dataSource.query(
            `SELECT DISTINCT "createdAt" AS c FROM agent_runs WHERE id IN (${saved.map(() => '?').join(', ')})`,
            saved.map((row) => row.id),
        );
        // The premise of every spec below: the rows really tie.
        expect(stamps).toHaveLength(1);
        return saved;
    }

    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
    const newestFirst = (rows: AgentRun[]) => ids(rows).reverse();

    describe.each([
        ['a Date stamp', {}],
        ["datetime('now') TEXT", { text: true }],
        ['a Date stamp, ids ascending with insertion', { ascendingIds: true }],
        ["datetime('now') TEXT, ids ascending with insertion", { text: true, ascendingIds: true }],
    ])('with runs tied on %s', (_label, options) => {
        it('findLatestForTask returns the run inserted last, the newer one queued', async () => {
            const [, newer] = await seedBurst(
                [{ status: 'completed' }, { status: 'queued', startedAt: null }],
                options,
            );

            const latest = await runs.findLatestForTask(TASK);

            expect(latest?.id).toBe(newer.id);
            expect(latest?.status).toBe('queued');
        });

        it('findLatestForTask returns the run inserted last across three tied runs', async () => {
            const seeded = await seedBurst(
                [
                    { status: 'running' },
                    { status: 'queued', startedAt: null },
                    { status: 'completed' },
                ],
                options,
            );

            expect((await runs.findLatestForTask(TASK))?.id).toBe(seeded[2].id);
        });

        it('findInFlightForTaskAgent returns the in-flight run inserted last', async () => {
            const seeded = await seedBurst(
                [
                    { status: 'queued', startedAt: null },
                    { status: 'queued', startedAt: null },
                    { status: 'running' },
                    { status: 'completed' },
                ],
                options,
            );

            expect((await runs.findInFlightForTaskAgent(TASK, AGENT_A))?.id).toBe(seeded[2].id);
            expect((await runs.findInFlightForTaskAgent(TASK, AGENT_A, USER))?.id).toBe(
                seeded[2].id,
            );
        });

        it('findInFlightForAgent returns the in-flight run inserted last, queued or running', async () => {
            const runningLast = await seedBurst(
                [
                    { status: 'queued', startedAt: null, taskId: null },
                    { status: 'queued', startedAt: null, taskId: null },
                    { status: 'running', taskId: null },
                ],
                options,
            );
            expect((await runs.findInFlightForAgent(AGENT_A))?.id).toBe(runningLast[2].id);

            const queuedLast = await seedBurst(
                [
                    { agentId: AGENT_B, status: 'running', taskId: null },
                    { agentId: AGENT_B, status: 'queued', startedAt: null, taskId: null },
                    { agentId: AGENT_B, status: 'running', taskId: null },
                    { agentId: AGENT_B, status: 'queued', startedAt: null, taskId: null },
                ],
                options,
            );
            expect((await runs.findInFlightForAgent(AGENT_B))?.id).toBe(queuedLast[3].id);
        });
    });

    describe('lists, newest first', () => {
        async function seedFour(): Promise<AgentRun[]> {
            return seedBurst([
                { status: 'completed' },
                { status: 'queued', startedAt: null },
                { status: 'running' },
                { status: 'queued', startedAt: null },
            ]);
        }

        async function expectOffsetPages(
            read: (limit: number, offset: number) => Promise<AgentRun[]>,
            expected: string[],
        ): Promise<void> {
            const first = ids(await read(2, 0));
            const second = ids(await read(2, 2));
            expect(first.filter((id) => second.includes(id))).toEqual([]);
            expect([...first, ...second]).toEqual(expected);
        }

        it('findByAgent lists tied runs newest first and pages without overlap', async () => {
            const seeded = await seedFour();

            expect(ids(await runs.findByAgent(AGENT_A))).toEqual(newestFirst(seeded));
            await expectOffsetPages(
                (limit, offset) => runs.findByAgent(AGENT_A, limit, offset),
                newestFirst(seeded),
            );
        });

        it('findByAgentAndUser lists tied runs newest first, with and without a scope', async () => {
            const seeded = await seedFour();

            expect(ids(await runs.findByAgentAndUser(AGENT_A, USER))).toEqual(newestFirst(seeded));
            await expectOffsetPages(
                (limit, offset) => runs.findByAgentAndUser(AGENT_A, USER, limit, offset),
                newestFirst(seeded),
            );
            // A tenant scope renders a two-branch OR where clause.
            const scope = {
                tenantId: '99999999-9999-4999-8999-999999999999',
                organizationId: null,
            };
            await expectOffsetPages(
                (limit, offset) => runs.findByAgentAndUser(AGENT_A, USER, limit, offset, scope),
                newestFirst(seeded),
            );
        });

        it('listSessionsForUser lists tied runs newest first, unfiltered and filtered', async () => {
            const seeded = await seedFour();
            const queued = seeded.filter((row) => row.status === 'queued');

            const [all, total] = await runs.listSessionsForUser(USER, {});
            expect(ids(all)).toEqual(newestFirst(seeded));
            expect(total).toBe(4);

            const filterSets: Array<Parameters<AgentRunRepository['listSessionsForUser']>[1]> = [
                { taskId: TASK },
                { agentId: AGENT_A },
                { triggerKind: 'task' },
            ];
            for (const filters of filterSets) {
                await expectOffsetPages(
                    async (limit, offset) =>
                        (await runs.listSessionsForUser(USER, filters, limit, offset))[0],
                    newestFirst(seeded),
                );
            }

            const [byStatus] = await runs.listSessionsForUser(USER, { status: 'queued' });
            expect(ids(byStatus)).toEqual(newestFirst(queued));
        });

        it('listSessionsForUser names the same latest run as findLatestForTask', async () => {
            await seedBurst([{ taskId: OTHER_TASK }]);
            await seedFour();

            const [rows] = await runs.listSessionsForUser(USER, { taskId: TASK });
            const latest = await runs.findLatestForTask(TASK);

            expect(rows[0].id).toBe(latest?.id);
        });

        it('listRecentForOrganization lists tied runs newest first', async () => {
            const seeded = await seedBurst([
                { organizationId: ORG },
                { organizationId: ORG, status: 'queued', startedAt: null },
                { organizationId: ORG },
            ]);

            expect(ids(await runs.listRecentForOrganization(ORG))).toEqual(newestFirst(seeded));
            expect(ids(await runs.listRecentForOrganization(ORG, 1))).toEqual([seeded[2].id]);
        });
    });

    describe('oldest-first readers', () => {
        it('findOldestQueuedForConcurrency drains the first-inserted parked run', async () => {
            const seeded = await seedBurst(
                [1, 2, 3].map(() => ({
                    workId: WORK,
                    status: 'queued' as const,
                    startedAt: null,
                    queuedReason: 'concurrency-limit',
                })),
            );

            const head = await runs.findOldestQueuedForConcurrency(WORK, 'concurrency-limit');

            expect(head?.id).toBe(seeded[0].id);
        });

        it('batch readers keep insertion order under a limit cut', async () => {
            const stuck = await seedBurst(
                [1, 2, 3].map(() => ({ status: 'running' as const, workId: WORK })),
            );
            expect(ids(await runs.findStuckNonTerminal(LATER, 2))).toEqual(ids(stuck.slice(0, 2)));
            await dataSource.getRepository(AgentRun).clear();

            const queued = await seedBurst(
                [1, 2, 3].map(() => ({ status: 'queued' as const, startedAt: null })),
            );
            expect(ids(await runs.findQueuedTooLong(LATER, 2))).toEqual(ids(queued.slice(0, 2)));
            await dataSource.getRepository(AgentRun).clear();

            const terminals = await seedBurst(
                [1, 2, 3].map(() => ({ terminalState: 'attached', lastHeartbeatAt: null })),
            );
            expect(ids(await runs.findStaleTerminalRuns(LATER, 2))).toEqual(
                ids(terminals.slice(0, 2)),
            );
            await dataSource.getRepository(AgentRun).clear();

            await seedBurst([
                { status: 'failed' },
                { status: 'cancelled' },
                { status: 'completed' },
            ]);
            const instants = await runs.listLedgerInstants(USER, WINDOW, {}, 2);
            expect(instants.map((row) => row.status)).toEqual(['failed', 'cancelled']);
        });
    });

    /**
     * The two blocks above seed ids that DESCEND with insertion, which an id
     * tie-break running the "wrong" way would also satisfy. The same readers
     * again, ids ascending with insertion, so only insertion order passes both.
     */
    describe('with ids ascending with insertion', () => {
        it('list readers keep tied runs newest first', async () => {
            const seeded = await seedBurst(
                [
                    { organizationId: ORG, status: 'completed' },
                    { organizationId: ORG, status: 'queued', startedAt: null },
                    { organizationId: ORG, status: 'running' },
                    { organizationId: ORG, status: 'queued', startedAt: null },
                ],
                { ascendingIds: true },
            );
            expect(seeded[0].id < seeded[3].id).toBe(true);

            expect(ids(await runs.findByAgent(AGENT_A))).toEqual(newestFirst(seeded));
            expect(ids(await runs.findByAgentAndUser(AGENT_A, USER))).toEqual(newestFirst(seeded));
            const [all] = await runs.listSessionsForUser(USER, {});
            expect(ids(all)).toEqual(newestFirst(seeded));
            const [firstPage] = await runs.listSessionsForUser(USER, { taskId: TASK }, 2, 0);
            expect(ids(firstPage)).toEqual(newestFirst(seeded).slice(0, 2));
            expect(ids(await runs.listRecentForOrganization(ORG))).toEqual(newestFirst(seeded));
            expect((await runs.findLatestForTask(TASK))?.id).toBe(seeded[3].id);
        });

        it('oldest-first readers take the first-inserted runs', async () => {
            const parked = await seedBurst(
                [1, 2, 3].map(() => ({
                    workId: WORK,
                    status: 'queued' as const,
                    startedAt: null,
                    queuedReason: 'concurrency-limit',
                })),
                { ascendingIds: true },
            );
            expect(parked[0].id < parked[2].id).toBe(true);
            expect((await runs.findOldestQueuedForConcurrency(WORK, 'concurrency-limit'))?.id).toBe(
                parked[0].id,
            );
            await dataSource.getRepository(AgentRun).clear();

            const stuck = await seedBurst(
                [1, 2, 3].map(() => ({ status: 'running' as const, workId: WORK })),
                { ascendingIds: true },
            );
            expect(ids(await runs.findStuckNonTerminal(LATER, 2))).toEqual(ids(stuck.slice(0, 2)));
        });
    });

    describe('listSessionsForUser under planner statistics', () => {
        afterEach(async () => {
            // Forget the statistics again so no other spec plans with them.
            await dataSource.query('DELETE FROM sqlite_stat1');
            await dataSource.query('ANALYZE sqlite_schema');
        });

        /**
         * Without statistics SQLite walks `idx_agent_runs_user_created`
         * backwards, which happens to list same-second rows newest first.
         * Once `ANALYZE` has seen a user with many runs, a task / agent / work
         * filter switches to that column's index plus a temp B-tree sort, and
         * the tie order becomes whatever that index yields.
         */
        it('keeps tied runs newest first when a filter index wins the plan', async () => {
            const repository = dataSource.getRepository(AgentRun);
            const filler = Array.from({ length: 400 }, (_, index) => {
                const n = String(index).padStart(12, '0');
                return repository.create({
                    id: `70000000-0000-4000-8000-${n}`,
                    userId: USER,
                    agentId: `60000000-0000-4000-8000-${n}`,
                    taskId: `50000000-0000-4000-8000-${n}`,
                    workId: `40000000-0000-4000-8000-${n}`,
                    triggerKind: 'task',
                    status: 'completed',
                    gateAttempts: 0,
                    persistent: false,
                    awaitingInput: false,
                    interruptRequested: false,
                    createdAt: new Date('2026-09-13T10:00:00.000Z'),
                } as Partial<AgentRun>);
            });
            await repository.save(filler, { chunk: 100 });
            const seeded = await seedBurst([
                { workId: WORK, status: 'completed' },
                { workId: WORK, status: 'queued', startedAt: null },
                { workId: WORK, status: 'running' },
                { workId: WORK, status: 'queued', startedAt: null },
            ]);
            await dataSource.query('ANALYZE');

            const filterSets: Array<Parameters<AgentRunRepository['listSessionsForUser']>[1]> = [
                { taskId: TASK },
                { agentId: AGENT_A },
                { workId: WORK },
            ];
            for (const filters of filterSets) {
                const [rows] = await runs.listSessionsForUser(USER, filters);
                expect(ids(rows)).toEqual(newestFirst(seeded));
            }
            const [firstPage] = await runs.listSessionsForUser(USER, { taskId: TASK }, 1, 0);
            expect(firstPage[0].id).toBe((await runs.findLatestForTask(TASK))?.id);
        });
    });

    describe('guards on the rowid tie-break itself', () => {
        it('agent_runs is a rowid table with no column shadowing rowid', async () => {
            expect(dataSource.getMetadata(AgentRun).withoutRowid).toBeFalsy();
            const columns: Array<{ name: string }> = await dataSource.query(
                'PRAGMA table_info(agent_runs)',
            );
            const names = columns.map((column) => column.name.toLowerCase());
            expect(names).toContain('createdat');
            for (const alias of ['rowid', 'oid', '_rowid_']) {
                expect(names).not.toContain(alias);
            }
        });

        it('a run inserted after the newest one was deleted is the latest', async () => {
            const seeded = await seedBurst([{ status: 'completed' }, { status: 'running' }]);
            await dataSource.getRepository(AgentRun).delete({ id: seeded[1].id });

            const [replacement] = await seedBurst([
                // Smallest id of all, so only insertion order can rank it newest.
                { id: '00000000-0000-4000-8000-000000000000', status: 'queued', startedAt: null },
            ]);
            const remaining = await dataSource
                .getRepository(AgentRun)
                .find({ where: { id: In([seeded[0].id, replacement.id]) } });
            expect(new Set(remaining.map((row) => row.createdAt.getTime())).size).toBe(1);

            expect((await runs.findLatestForTask(TASK))?.id).toBe(replacement.id);
        });
    });
});

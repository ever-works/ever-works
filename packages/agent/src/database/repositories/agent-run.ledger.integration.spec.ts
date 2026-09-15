import { DataSource } from 'typeorm';
import { Agent, AgentStatus } from '@src/entities/agent.entity';
import { AgentRun } from '@src/entities/agent-run.entity';
import { Mission } from '@src/entities/mission.entity';
import { Task } from '@src/entities/task.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository, type RunLedgerQueryFilters } from './agent-run.repository';

/**
 * Runs ledger (AW-09) — the window-shaped reads, executed against a real
 * in-memory database rather than a mocked query builder.
 *
 * What is pinned here is what a mock cannot see: the ledger instant
 * (`startedAt`, else `createdAt`) and its half-open window, the ownership
 * predicate applied under EVERY filter permutation, cursor pages that stay
 * stable while new runs arrive, the LIKE escaping of the search, and the
 * mission sub-select. better-sqlite3 is what CI and the e2e stack run, so a
 * Postgres-only construct would fail here.
 */
describe('AgentRunRepository — runs ledger reads (integration)', () => {
    let dataSource: DataSource;
    let runs: AgentRunRepository;
    const queries: string[] = [];

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const MISSION = '66666666-6666-4666-8666-666666666666';
    const TASK_IN_MISSION = '77777777-7777-4777-8777-777777777777';
    const TASK_LOOSE = '88888888-8888-4888-8888-888888888888';

    const WINDOW = {
        from: new Date('2026-09-08T00:00:00.000Z'),
        to: new Date('2026-09-09T00:00:00.000Z'),
    };
    const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00.000Z`);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            // Captured so the emitted SQL text can be asserted on: SQLite
            // matches unquoted camelCase identifiers case-insensitively, but
            // Postgres folds them to lower case and fails.
            logging: ['query'],
            logger: {
                logQuery: (query: string) => queries.push(query),
                logQueryError: () => undefined,
                logQuerySlow: () => undefined,
                logSchemaBuild: () => undefined,
                logMigration: () => undefined,
                log: () => undefined,
            },
        });
        await dataSource.initialize();
        // Read-model specs: parent rows are seeded only where a label or the
        // mission sub-select needs them, so referential integrity is off.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        runs = new AgentRunRepository(dataSource.getRepository(AgentRun));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        for (const entity of [AgentRun, Agent, Task, Mission]) {
            await dataSource.getRepository(entity).clear();
        }
    });

    let seq = 0;
    function seedRun(overrides: Partial<AgentRun>): Promise<AgentRun> {
        seq += 1;
        const repository = dataSource.getRepository(AgentRun);
        return repository.save(
            repository.create({
                userId: USER,
                agentId: AGENT_A,
                triggerKind: 'task',
                status: 'completed',
                gateAttempts: 0,
                persistent: false,
                awaitingInput: false,
                interruptRequested: false,
                startedAt: at('09:00'),
                createdAt: at('08:59'),
                summary: `run ${seq}`,
                ...overrides,
            } as Partial<AgentRun>),
        );
    }

    const page = (
        filters: RunLedgerQueryFilters = {},
        limit = 50,
        cursor?: { at: Date; id: string },
        userId = USER,
    ) => runs.listLedgerPage(userId, WINDOW, filters, limit, cursor);

    describe('listLedgerPage', () => {
        it('places a run at its start, or its creation when it never started, newest first', async () => {
            const early = await seedRun({ startedAt: at('09:00') });
            const queued = await seedRun({
                status: 'queued',
                startedAt: null,
                createdAt: at('11:00'),
            });
            const late = await seedRun({ startedAt: at('10:00'), createdAt: at('07:00') });

            const rows = await page();

            expect(rows.map((row) => row.id)).toEqual([queued.id, late.id, early.id]);
        });

        it('honours the half-open window on the ledger instant', async () => {
            await seedRun({ startedAt: new Date(WINDOW.from.getTime() - 1) });
            await seedRun({ startedAt: WINDOW.to });
            const included = await seedRun({ startedAt: WINDOW.from });

            const rows = await page();

            expect(rows.map((row) => row.id)).toEqual([included.id]);
        });

        it("never returns another user's runs, whatever the filters", async () => {
            await seedRun({ userId: OTHER_USER, summary: 'secret plan', status: 'failed' });
            const permutations: RunLedgerQueryFilters[] = [
                {},
                { agentIds: [AGENT_A] },
                { statuses: ['failed'] },
                { triggerKinds: ['task'] },
                { workId: WORK },
                { search: 'secret' },
                {
                    agentIds: [AGENT_A],
                    statuses: ['failed'],
                    triggerKinds: ['task'],
                    search: 'plan',
                },
            ];

            for (const filters of permutations) {
                expect(await page(filters)).toEqual([]);
                expect(await runs.countLedger(USER, WINDOW, filters)).toBe(0);
            }
        });

        it('applies the Organization scope inside the repository', async () => {
            const personal = await seedRun({ organizationId: null, tenantId: null });
            const orgRun = await seedRun({ organizationId: ORG, tenantId: null });

            const inOrg = await runs.listLedgerPage(USER, WINDOW, {}, 50, undefined, {
                tenantId: null,
                organizationId: ORG,
            });
            const inPersonal = await runs.listLedgerPage(USER, WINDOW, {}, 50, undefined, {
                tenantId: null,
                organizationId: null,
            });

            expect(inOrg.map((row) => row.id)).toEqual([orgRun.id]);
            expect(inPersonal.map((row) => row.id)).toEqual([personal.id]);
        });

        it('ANDs across filter dimensions and ORs within one', async () => {
            const a = await seedRun({ agentId: AGENT_A, status: 'failed', startedAt: at('09:00') });
            const b = await seedRun({ agentId: AGENT_B, status: 'failed', startedAt: at('09:10') });
            await seedRun({ agentId: AGENT_B, status: 'completed', startedAt: at('09:20') });

            const rows = await page({ agentIds: [AGENT_A, AGENT_B], statuses: ['failed'] });

            expect(rows.map((row) => row.id)).toEqual([b.id, a.id]);
        });

        it('keeps pages stable when a newer run arrives between two page reads', async () => {
            const seeded: AgentRun[] = [];
            for (const hhmm of ['09:00', '09:10', '09:20', '09:30']) {
                seeded.push(await seedRun({ startedAt: at(hhmm) }));
            }
            const first = await page({}, 2);
            expect(first.map((row) => row.id)).toEqual([seeded[3].id, seeded[2].id]);

            await seedRun({ startedAt: at('09:40') });
            const last = first[first.length - 1];
            const second = await page({}, 2, { at: last.startedAt as Date, id: last.id });

            expect(second.map((row) => row.id)).toEqual([seeded[1].id, seeded[0].id]);
        });

        it('breaks ties on the same instant by id so no row is skipped or repeated', async () => {
            const same = at('09:00');
            const seeded = await Promise.all([1, 2, 3].map(() => seedRun({ startedAt: same })));
            const expected = seeded
                .map((row) => row.id)
                .sort()
                .reverse();

            const first = await page({}, 2);
            const tail = first[first.length - 1];
            const second = await page({}, 2, { at: same, id: tail.id });

            expect([...first, ...second].map((row) => row.id)).toEqual(expected);
        });

        it('matches the search against summary and error, case-insensitively, with LIKE characters escaped', async () => {
            const bySummary = await seedRun({
                summary: 'Merged the Release branch',
                startedAt: at('09:00'),
            });
            const byError = await seedRun({
                summary: null,
                errorMessage: 'RELEASE token expired',
                startedAt: at('09:10'),
            });
            await seedRun({ summary: 'unrelated', startedAt: at('09:20') });
            const literal = await seedRun({ summary: '100% done', startedAt: at('09:30') });

            const release = await page({ search: 'release' });
            expect(release.map((row) => row.id)).toEqual([byError.id, bySummary.id]);

            // `%` is a literal here, not a wildcard that matches everything.
            const percent = await page({ search: '0%' });
            expect(percent.map((row) => row.id)).toEqual([literal.id]);
        });

        it('narrows by Mission through the run Task', async () => {
            const taskRepo = dataSource.getRepository(Task);
            await taskRepo.save(
                taskRepo.create({
                    id: TASK_IN_MISSION,
                    userId: USER,
                    slug: 'T-1',
                    title: 'Review open pull requests',
                    createdByType: 'user',
                    createdById: USER,
                    missionId: MISSION,
                } as Partial<Task>),
            );
            await taskRepo.save(
                taskRepo.create({
                    id: TASK_LOOSE,
                    userId: USER,
                    slug: 'T-2',
                    title: 'Loose task',
                    createdByType: 'user',
                    createdById: USER,
                    missionId: null,
                } as Partial<Task>),
            );
            const inMission = await seedRun({ taskId: TASK_IN_MISSION });
            await seedRun({ taskId: TASK_LOOSE });
            await seedRun({ taskId: null, triggerKind: 'heartbeat' });

            const rows = await page({ missionId: MISSION });

            expect(rows.map((row) => row.id)).toEqual([inMission.id]);
        });
    });

    describe('hasAnyRunForUser', () => {
        it('answers per user and per scope, regardless of window', async () => {
            await seedRun({ startedAt: new Date('2024-01-01T00:00:00.000Z'), organizationId: ORG });

            expect(await runs.hasAnyRunForUser(USER)).toBe(true);
            expect(await runs.hasAnyRunForUser(OTHER_USER)).toBe(false);
            expect(await runs.hasAnyRunForUser(USER, { tenantId: null, organizationId: ORG })).toBe(
                true,
            );
            expect(
                await runs.hasAnyRunForUser(USER, { tenantId: null, organizationId: null }),
            ).toBe(false);
        });
    });

    describe('aggregateLedger', () => {
        it('groups by status and trigger and counts which runs carry cost and tokens', async () => {
            await seedRun({
                status: 'completed',
                triggerKind: 'heartbeat',
                durationMs: 1000,
                costCents: 12,
                totalTokens: 100,
            });
            await seedRun({
                status: 'completed',
                triggerKind: 'heartbeat',
                durationMs: 500,
                costCents: null,
                totalTokens: null,
            });
            await seedRun({
                status: 'failed',
                triggerKind: 'task',
                durationMs: 250,
                costCents: 3,
                totalTokens: 40,
            });
            await seedRun({ userId: OTHER_USER, status: 'failed', costCents: 999 });

            const groups = await runs.aggregateLedger(USER, WINDOW, {});

            expect(groups).toEqual(
                expect.arrayContaining([
                    {
                        status: 'completed',
                        triggerKind: 'heartbeat',
                        runs: 2,
                        durationMs: 1500,
                        costCents: 12,
                        costedRuns: 1,
                        tokens: 100,
                        tokenRuns: 1,
                    },
                    {
                        status: 'failed',
                        triggerKind: 'task',
                        runs: 1,
                        durationMs: 250,
                        costCents: 3,
                        costedRuns: 1,
                        tokens: 40,
                        tokenRuns: 1,
                    },
                ]),
            );
            expect(groups).toHaveLength(2);
        });
    });

    describe('countScheduledFailuresByAgent', () => {
        it('keeps only heartbeat failures that reach the threshold', async () => {
            await seedRun({ agentId: AGENT_A, triggerKind: 'heartbeat', status: 'failed' });
            await seedRun({ agentId: AGENT_A, triggerKind: 'heartbeat', status: 'failed' });
            await seedRun({ agentId: AGENT_A, triggerKind: 'task', status: 'failed' });
            await seedRun({ agentId: AGENT_B, triggerKind: 'heartbeat', status: 'failed' });
            await seedRun({ agentId: AGENT_B, triggerKind: 'heartbeat', status: 'completed' });

            const rows = await runs.countScheduledFailuresByAgent(USER, WINDOW, {}, 2);

            expect(rows).toEqual([{ agentId: AGENT_A, failures: 2 }]);
        });
    });

    describe('listLedgerInstants', () => {
        it('returns the ledger instant and status of each run, capped', async () => {
            await seedRun({ startedAt: at('09:00'), status: 'failed' });
            await seedRun({ startedAt: null, createdAt: at('10:00'), status: 'queued' });
            await seedRun({ startedAt: at('11:00') });

            const all = await runs.listLedgerInstants(USER, WINDOW, {}, 10);
            const capped = await runs.listLedgerInstants(USER, WINDOW, {}, 2);

            expect(all).toHaveLength(3);
            expect(all.map((row) => row.status).sort()).toEqual(['completed', 'failed', 'queued']);
            expect(all.find((row) => row.status === 'queued')?.at.toISOString()).toBe(
                at('10:00').toISOString(),
            );
            expect(capped).toHaveLength(2);
        });
    });

    describe('emitted SQL', () => {
        it('quotes every camelCase column reference, so the reads also run on Postgres', async () => {
            await seedRun({ status: 'failed', triggerKind: 'heartbeat' });
            queries.length = 0;
            const filters: RunLedgerQueryFilters = {
                agentIds: [AGENT_A],
                statuses: ['failed'],
                triggerKinds: ['heartbeat'],
                workId: WORK,
                missionId: MISSION,
                search: 'x',
            };
            const scope = { tenantId: null, organizationId: ORG };

            await runs.listLedgerPage(
                USER,
                WINDOW,
                filters,
                5,
                { at: at('12:00'), id: AGENT_A },
                scope,
            );
            await runs.countLedger(USER, WINDOW, filters, scope);
            await runs.aggregateLedger(USER, WINDOW, filters, scope);
            await runs.countScheduledFailuresByAgent(USER, WINDOW, filters, 2, scope);
            await runs.listLedgerInstants(USER, WINDOW, filters, 10, scope);

            const ledgerSql = queries.filter((query) => query.includes('agent_runs'));
            expect(ledgerSql.length).toBeGreaterThanOrEqual(5);
            for (const sql of ledgerSql) {
                // An unquoted `run.startedAt` / `ledgerTask.missionId` would
                // be a lower-cased, non-existent column on Postgres.
                expect(sql).not.toMatch(/(^|[^"])\b(run|ledgerTask)\.[a-zA-Z]+/);
            }
        });
    });

    describe('resolveLedgerLabels', () => {
        it('resolves names, the archived flag and a Task Mission in one query per kind', async () => {
            const agentRepo = dataSource.getRepository(Agent);
            await agentRepo.save(
                agentRepo.create({
                    id: AGENT_A,
                    userId: USER,
                    scope: 'user',
                    name: 'Ops',
                    slug: 'ops',
                    permissions: {},
                    status: AgentStatus.ARCHIVED,
                } as unknown as Partial<Agent>),
            );
            const missionRepo = dataSource.getRepository(Mission);
            await missionRepo.save(
                missionRepo.create({
                    id: MISSION,
                    userId: USER,
                    title: 'Ship the September release',
                    description: 'desc',
                    type: 'one-shot',
                } as unknown as Partial<Mission>),
            );
            const taskRepo = dataSource.getRepository(Task);
            await taskRepo.save(
                taskRepo.create({
                    id: TASK_IN_MISSION,
                    userId: USER,
                    slug: 'T-1',
                    title: 'Review open pull requests',
                    createdByType: 'user',
                    createdById: USER,
                    missionId: MISSION,
                } as Partial<Task>),
            );
            const find = jest.spyOn(dataSource.manager, 'find');

            const labels = await runs.resolveLedgerLabels({
                agentIds: [AGENT_A, AGENT_A, AGENT_B],
                taskIds: [TASK_IN_MISSION],
                workIds: [],
            });

            expect(labels.agents.get(AGENT_A)).toEqual({ name: 'Ops', archived: true });
            expect(labels.agents.has(AGENT_B)).toBe(false);
            expect(labels.tasks.get(TASK_IN_MISSION)).toEqual({
                title: 'Review open pull requests',
                missionId: MISSION,
            });
            expect(labels.missions.get(MISSION)).toBe('Ship the September release');
            // agents + tasks + missions; the empty works list issues no query.
            expect(find).toHaveBeenCalledTimes(3);
            find.mockRestore();
        });
    });
});

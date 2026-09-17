import { DataSource, SelectQueryBuilder, type Repository } from 'typeorm';
import { AgentRun } from '../../entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository } from './agent-run.repository';

/**
 * The same-second tie-break (`insertion-order.ts`) is SQLite-only. This spec
 * pins that the Postgres SQL of every time-ordered `agent_runs` read is
 * byte-for-byte what it was before the tie-break existed — and, for the two
 * ledger reads, that the canonical millisecond sort key
 * (`time-sort-key.ts`) is the ONLY thing that changed: no rowid, the same
 * quoted identifiers, the same `(instant, id)` keyset shape.
 *
 * No database is needed: the repository runs over an unconnected Postgres
 * DataSource with metadata built, and the terminal `getOne` / `getMany` /
 * `getManyAndCount` calls are intercepted to capture `getQuery()`.
 *
 * A full-entity select list is collapsed to `<all columns>` so adding a
 * column to `agent_runs` does not churn these literals; explicit partial
 * select lists are kept verbatim.
 */
describe('AgentRunRepository — Postgres SQL for time-ordered reads', () => {
    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const TASK = '77777777-7777-4777-8777-777777777777';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const CUTOFF = new Date('2026-09-14T10:00:00.000Z');
    const WINDOW = {
        from: new Date('2026-09-08T00:00:00.000Z'),
        to: new Date('2026-09-09T00:00:00.000Z'),
    };

    const sql = (...parts: string[]) => parts.join(' ');

    /**
     * The ledger's instant as `time-sort-key.ts` renders it on Postgres:
     * the canonical millisecond text of `COALESCE(startedAt, createdAt)`,
     * which every ledger window bound, cursor comparison and ORDER BY goes
     * through so a millisecond cursor can name an exact position in a
     * microsecond column.
     */
    const LEDGER_KEY =
        `to_char(COALESCE("run"."startedAt", "run"."createdAt"), ` +
        `'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
    /** The same rendering of a bound `Date` parameter. */
    const ledgerParameterKey = (parameter: string) =>
        `to_char(CAST(:${parameter} AS timestamp), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

    async function buildRepository(
        type: 'postgres' | 'better-sqlite3',
    ): Promise<{ orm: Repository<AgentRun>; runs: AgentRunRepository; allColumns: string }> {
        const dataSource =
            type === 'postgres'
                ? new DataSource({
                      type,
                      host: '127.0.0.1',
                      username: 'unused',
                      password: 'unused',
                      database: 'unused',
                      entities: ENTITIES,
                  })
                : new DataSource({ type, database: ':memory:', entities: ENTITIES });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const orm = dataSource.getRepository(AgentRun);
        const allColumns = dataSource
            .getMetadata(AgentRun)
            .columns.map(
                (column) => `"run"."${column.databaseName}" AS "run_${column.databaseName}"`,
            )
            .join(', ');
        return { orm, runs: new AgentRunRepository(orm), allColumns };
    }

    /** Run `call`, returning the SQL of every select it executed. */
    async function captureSql(call: () => Promise<unknown>): Promise<string[]> {
        const captured: string[] = [];
        const record = (qb: SelectQueryBuilder<AgentRun>) => captured.push(qb.getQuery());
        const spies = [
            jest.spyOn(SelectQueryBuilder.prototype, 'getOne').mockImplementation(function (
                this: SelectQueryBuilder<AgentRun>,
            ) {
                record(this);
                return Promise.resolve(null);
            }),
            jest.spyOn(SelectQueryBuilder.prototype, 'getMany').mockImplementation(function (
                this: SelectQueryBuilder<AgentRun>,
            ) {
                record(this);
                return Promise.resolve([]);
            }),
            jest
                .spyOn(SelectQueryBuilder.prototype, 'getManyAndCount')
                .mockImplementation(function (this: SelectQueryBuilder<AgentRun>) {
                    record(this);
                    return Promise.resolve([[], 0] as [AgentRun[], number]);
                }),
        ];
        try {
            await call();
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
        return captured;
    }

    let postgres: Awaited<ReturnType<typeof buildRepository>>;

    beforeAll(async () => {
        postgres = await buildRepository('postgres');
    });

    afterEach(() => jest.restoreAllMocks());

    const CASES: Array<[string, (runs: AgentRunRepository) => Promise<unknown>, string]> = [
        [
            'findStuckNonTerminal',
            (runs) => runs.findStuckNonTerminal(CUTOFF, 10, ['stop-flag']),
            sql(
                'SELECT "run"."id" AS "run_id", "run"."agentId" AS "run_agentId", "run"."triggerKind" AS "run_triggerKind", "run"."status" AS "run_status", "run"."startedAt" AS "run_startedAt", "run"."workId" AS "run_workId", "run"."awaitingInput" AS "run_awaitingInput", "run"."queuedReason" AS "run_queuedReason", "run"."createdAt" AS "run_createdAt"',
                'FROM "agent_runs" "run"',
                'WHERE "run"."status" IN (:...statuses)',
                'AND ("run"."awaitingInput" IS NULL OR "run"."awaitingInput" = :notAwaiting)',
                'AND ("run"."queuedReason" IS NULL OR "run"."queuedReason" NOT IN (:...exemptQueuedReasons))',
                'AND COALESCE("run"."startedAt", "run"."createdAt") <= :cutoff',
                'ORDER BY COALESCE("run"."startedAt", "run"."createdAt") ASC LIMIT 10',
            ),
        ],
        [
            'findQueuedTooLong',
            (runs) => runs.findQueuedTooLong(CUTOFF, 10),
            sql(
                'SELECT "run"."id" AS "run_id", "run"."agentId" AS "run_agentId", "run"."userId" AS "run_userId", "run"."taskId" AS "run_taskId", "run"."workId" AS "run_workId", "run"."queuedReason" AS "run_queuedReason", "run"."createdAt" AS "run_createdAt"',
                'FROM "agent_runs" "run"',
                'WHERE "run"."status" = :queued AND "run"."attentionReason" IS NULL AND "run"."createdAt" <= :cutoff',
                'ORDER BY "run_createdAt" ASC LIMIT 10',
            ),
        ],
        [
            'findStaleTerminalRuns',
            (runs) => runs.findStaleTerminalRuns(CUTOFF, 50),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."terminalState" IN (:...states)',
                'AND ("run"."lastHeartbeatAt" IS NULL OR "run"."lastHeartbeatAt" < :cutoff)',
                'ORDER BY "run"."createdAt" ASC LIMIT 50',
            ),
        ],
        [
            'findInFlightForTaskAgent',
            (runs) =>
                runs.findInFlightForTaskAgent(TASK, AGENT, USER, {
                    tenantId: TENANT,
                    organizationId: null,
                }),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."taskId" = :taskId AND "run"."agentId" = :agentId AND "run"."status" IN (:...statuses)',
                'AND "run"."userId" = :userId',
                'AND ("run"."organizationId" IS NULL AND ("run"."tenantId" = :inFlightRunTenantId OR "run"."tenantId" IS NULL))',
                'ORDER BY "run"."createdAt" DESC',
            ),
        ],
        [
            'findLatestForTask',
            (runs) => runs.findLatestForTask(TASK),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."taskId" = :taskId',
                'ORDER BY "run"."createdAt" DESC',
            ),
        ],
        [
            'findInFlightForAgent',
            (runs) => runs.findInFlightForAgent(AGENT),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."agentId" = :agentId AND "run"."status" IN (:...statuses)',
                'ORDER BY "run"."createdAt" DESC',
            ),
        ],
        [
            'findOldestQueuedForConcurrency',
            (runs) => runs.findOldestQueuedForConcurrency(WORK, 'concurrency-limit'),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."workId" = :workId AND "run"."status" = :status AND "run"."queuedReason" = :queuedReason',
                'ORDER BY "run"."createdAt" ASC',
            ),
        ],
        [
            'listSessionsForUser',
            (runs) => runs.listSessionsForUser(USER, {}, 25, 0),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."userId" = :userId',
                'ORDER BY "run"."createdAt" DESC LIMIT 25 OFFSET 0',
            ),
        ],
        [
            'listSessionsForUser (every filter, scoped, paged)',
            (runs) =>
                runs.listSessionsForUser(
                    USER,
                    {
                        status: 'queued',
                        workId: WORK,
                        agentId: AGENT,
                        taskId: TASK,
                        triggerKind: 'task',
                        attention: true,
                    },
                    10,
                    20,
                    { tenantId: null, organizationId: ORG },
                ),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."userId" = :userId',
                'AND ("run"."tenantId" IS NULL AND "run"."organizationId" = :ownershipOrganizationId)',
                'AND ("run"."awaitingInput" = :isAwaiting OR "run"."attentionReason" IS NOT NULL)',
                'AND "run"."status" = :status AND "run"."workId" = :workId AND "run"."agentId" = :agentId',
                'AND "run"."taskId" = :taskId AND "run"."triggerKind" = :triggerKind',
                'ORDER BY "run"."createdAt" DESC LIMIT 10 OFFSET 20',
            ),
        ],
        [
            'listRecentForOrganization',
            (runs) => runs.listRecentForOrganization(ORG, 400),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."organizationId" = :organizationId',
                'ORDER BY "run"."createdAt" DESC LIMIT 400',
            ),
        ],
        [
            'listLedgerInstants',
            (runs) => runs.listLedgerInstants(USER, WINDOW, {}, 20000),
            sql(
                'SELECT "run"."id" AS "run_id", "run"."status" AS "run_status", "run"."startedAt" AS "run_startedAt", "run"."createdAt" AS "run_createdAt"',
                'FROM "agent_runs" "run"',
                'WHERE "run"."userId" = :userId',
                `AND ${LEDGER_KEY} >= ${ledgerParameterKey('ledgerFrom')}`,
                `AND ${LEDGER_KEY} < ${ledgerParameterKey('ledgerTo')}`,
                'ORDER BY "run_createdAt" ASC LIMIT 20000',
            ),
        ],
        [
            'listLedgerPage',
            (runs) =>
                runs.listLedgerPage(USER, WINDOW, {}, 51, {
                    at: CUTOFF,
                    id: '00000000-0000-4000-8000-000000000001',
                }),
            sql(
                'SELECT <all columns> FROM "agent_runs" "run"',
                'WHERE "run"."userId" = :userId',
                `AND ${LEDGER_KEY} >= ${ledgerParameterKey('ledgerFrom')}`,
                `AND ${LEDGER_KEY} < ${ledgerParameterKey('ledgerTo')}`,
                `AND (${LEDGER_KEY} < ${ledgerParameterKey('ledgerCursorAt')} OR (${LEDGER_KEY} = ${ledgerParameterKey('ledgerCursorAt')} AND "run"."id" < :ledgerCursorId))`,
                `ORDER BY ${LEDGER_KEY} DESC, "run"."id" DESC LIMIT 51`,
            ),
        ],
    ];

    it.each(CASES)('%s emits the unchanged Postgres SQL', async (_name, call, expected) => {
        const captured = await captureSql(() => call(postgres.runs));

        expect(captured).toHaveLength(1);
        const [emitted] = captured;
        expect(emitted).not.toContain('rowid');
        expect(
            emitted.split(`SELECT ${postgres.allColumns} FROM`).join('SELECT <all columns> FROM'),
        ).toBe(expected);
    });

    it('findByAgent keeps the plain find() call on Postgres', async () => {
        const find = jest.spyOn(postgres.orm, 'find').mockResolvedValue([]);
        const createQueryBuilder = jest.spyOn(postgres.orm, 'createQueryBuilder');

        await postgres.runs.findByAgent(AGENT, 5, 10);

        expect(find).toHaveBeenCalledTimes(1);
        expect(find).toHaveBeenCalledWith({
            where: { agentId: AGENT },
            order: { createdAt: 'DESC' },
            take: 5,
            skip: 10,
        });
        expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    it('findByAgentAndUser keeps the plain find() call on Postgres', async () => {
        const find = jest.spyOn(postgres.orm, 'find').mockResolvedValue([]);
        const createQueryBuilder = jest.spyOn(postgres.orm, 'createQueryBuilder');

        await postgres.runs.findByAgentAndUser(AGENT, USER, 25, 50);

        expect(find).toHaveBeenCalledTimes(1);
        expect(find).toHaveBeenCalledWith({
            where: { agentId: AGENT, userId: USER },
            order: { createdAt: 'DESC' },
            take: 25,
            skip: 50,
        });
        expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    describe('on better-sqlite3', () => {
        let sqlite: Awaited<ReturnType<typeof buildRepository>>;

        beforeAll(async () => {
            sqlite = await buildRepository('better-sqlite3');
        });

        it('adds the rowid tie-break to a latest-run read (so the capture above would see one)', async () => {
            const [emitted] = await captureSql(() => sqlite.runs.findLatestForTask(TASK));

            expect(emitted).toContain('ORDER BY "run"."createdAt" DESC, "run".rowid DESC');
        });

        it('never adds rowid to listLedgerPage, whose run.id order is already unique', async () => {
            const captured = await captureSql(() =>
                sqlite.runs.listLedgerPage(USER, WINDOW, {}, 51, {
                    at: CUTOFF,
                    id: '00000000-0000-4000-8000-000000000001',
                }),
            );

            expect(captured).toHaveLength(1);
            expect(captured[0]).not.toContain('rowid');
            expect(captured[0]).toContain('DESC, "run"."id" DESC LIMIT 51');
        });
    });
});

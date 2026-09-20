// Same short-circuit as `agents.controller.session-detail.spec.ts`: the
// controller only needs these barrels for DI tokens, and the REAL
// repository under test is imported from `@ever-works/agent/database`.
jest.mock('@ever-works/agent/agents', () => ({
    __esModule: true,
    AGENT_HEARTBEAT_TRIGGER: 'AGENT_HEARTBEAT_TRIGGER',
    AGENT_RUN_CANCELLER: 'AGENT_RUN_CANCELLER',
    AGENT_FILE_NAMES: ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'],
    AgentScope: { TENANT: 'tenant', MISSION: 'mission', IDEA: 'idea', WORK: 'work' },
    AgentStatus: {
        DRAFT: 'draft',
        ACTIVE: 'active',
        PAUSED: 'paused',
        ERROR: 'error',
        ARCHIVED: 'archived',
    },
    AgentIdleBehavior: { PROPOSE: 'propose', SLEEP: 'sleep', SELF_IMPROVE: 'self-improve' },
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AGENT_PERMISSIONS_DEFAULT: {},
    AgentsService: class {},
    AgentFileService: class {},
    AgentExportService: class {},
    AgentScheduleDispatcherService: class {},
    AgentRunRepository: class {},
    AgentRunLogRepository: class {},
    RunDispatchGateService: class {},
    RunSteeringService: class {},
    SkillBindingRepository: class {},
    PluginUsageRepository: class {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    __esModule: true,
    AGENT_TASK_EXECUTE_DISPATCHER: 'AGENT_TASK_EXECUTE_DISPATCHER',
    TasksService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    __esModule: true,
    ActivityActionType: {},
    ActivityStatus: { COMPLETED: 'completed' },
}));

import { types as pgTypes } from 'pg';
import { prepareValue } from 'pg/lib/utils';
import { DataSource, SelectQueryBuilder, type ObjectLiteral } from 'typeorm';
import { AGENT_RUN_TIMELINE_CURSOR_PATTERN } from '@ever-works/contracts';
import { AgentRunLogRepository } from '@ever-works/agent/database';
import { AgentRunLog } from '@ever-works/agent/entities';
import { AgentsController } from './agents.controller';

/**
 * Session detail (Feature K) — `GET /api/agents/runs/:runId/detail`
 * paged the way a client pages it: follow `nextCursor` until it is null.
 *
 * Asserting the emitted SQL cannot catch the defect this exists for, and
 * did not. On Postgres `agent_run_logs.createdAt` is `timestamp DEFAULT
 * now()`, i.e. MICROSECONDS, while `pg` builds the row's `Date` with the
 * sub-millisecond digits cut off, so the cursor the controller mints for a
 * row stored at `.123456` names `.123`. A keyset that compares the column
 * against that bound instant finds the cursor row itself still `>` it,
 * and a full page whose rows all sit in the last row's millisecond — every
 * page at `limit=1`, a message and its tool call at `limit=2` — comes back
 * identical with the identical `nextCursor`, forever. Only a walk sees
 * that, so every case below walks, through the REAL controller (its own
 * cursor parser and minting), over the REAL repository, and asserts that
 * (a) the walk ends, (b) the cursor moves on every step and (c) the pages
 * together are every row exactly once, in order. The walk is bounded, so
 * a loop FAILS instead of hanging.
 *
 * Two stores run the same cases:
 *
 * - `EVER_WORKS_POSTGRES_TIMELINE_TEST_URL` set: a real Postgres (a
 *   dedicated, disposable database — the schema is dropped).
 * - always: a model of the Postgres wire that keeps the three facts the
 *   defect is made of and nothing else. Rows are stored at microsecond
 *   precision as fixed-width text, so comparing them is comparing
 *   instants; the SQL executed is exactly what TypeORM emitted for the
 *   `postgres` driver (run by better-sqlite3, which evaluates the same
 *   predicates and sub-selects); a bound `Date` goes through `pg`'s own
 *   `prepareValue` and then Postgres's rule for `timestamp` input (the
 *   zone offset is ignored); and a stored instant comes back through `pg`'s
 *   own `timestamp` parser, which is where the microseconds are lost.
 */

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';

interface SeedRow {
    id: string;
    runId: string;
    step: 'assistant-message' | 'user-message' | 'tool-invocation';
    /** Stored instant, `YYYY-MM-DD HH:MM:SS.ffffff` — microseconds, as Postgres keeps it. */
    createdAt: string;
}

interface TimelineStore {
    logs: AgentRunLogRepository;
    seed(rows: readonly SeedRow[]): Promise<void>;
    remove(id: string): Promise<void>;
    /** The instant as the store holds it, at full precision. */
    storedInstant(id: string): Promise<string>;
    reset(): Promise<void>;
    close(): Promise<void>;
}

const at = (micros: string): string => `2026-09-17 12:00:00.${micros}`;
const uuid = (tail: string): string => `a0000000-0000-4000-8000-0000000000${tail}`;

/**
 * An assistant message and the tool call it asked for, a few hundred
 * microseconds apart inside ONE millisecond, then the reply in the next.
 * The ids sort in a different order than the instants, so an order that
 * lost the microseconds would show here too.
 */
const PAIR: readonly SeedRow[] = [
    { id: uuid('03'), runId: RUN, step: 'assistant-message', createdAt: at('123100') },
    { id: uuid('01'), runId: RUN, step: 'tool-invocation', createdAt: at('123900') },
    { id: uuid('02'), runId: RUN, step: 'assistant-message', createdAt: at('124200') },
];

/**
 * Five rows inside one millisecond — two of them at the SAME microsecond,
 * where only the id can order them — then a row whose microsecond part is
 * exactly `000`, the one instant a millisecond cursor can name exactly.
 */
const BURST: readonly SeedRow[] = [
    { id: uuid('15'), runId: RUN, step: 'user-message', createdAt: at('456001') },
    { id: uuid('14'), runId: RUN, step: 'tool-invocation', createdAt: at('456200') },
    { id: uuid('13'), runId: RUN, step: 'assistant-message', createdAt: at('456200') },
    { id: uuid('11'), runId: RUN, step: 'tool-invocation', createdAt: at('456700') },
    { id: uuid('12'), runId: RUN, step: 'assistant-message', createdAt: at('456999') },
    { id: uuid('10'), runId: RUN, step: 'assistant-message', createdAt: at('457000') },
];

/** Plain code-unit order: what fixed-width instants and lower-case uuids sort by. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Timeline order: the stored instant, then the id — what the ORDER BY walks. */
function timelineOrder(rows: readonly SeedRow[]): string[] {
    return rows
        .filter((row) => row.runId === RUN)
        .slice()
        .sort((a, b) => byCodeUnit(a.createdAt, b.createdAt) || byCodeUnit(a.id, b.id))
        .map((row) => row.id);
}

/** Postgres's `timestamp` input rule for the text `pg` sends: the zone is ignored. */
function postgresTimestampInput(text: string): string {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(text);
    if (!match) throw new Error(`Not a timestamp literal: ${text}`);
    const [, date, time, fraction = ''] = match;
    return `${date} ${time}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}

const STORED_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const INSERT_ROW =
    'INSERT INTO "agent_run_logs" ("id", "runId", "level", "step", "message", "createdAt") VALUES ';

async function microsecondModelStore(): Promise<TimelineStore> {
    const dataSource = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        username: 'unused',
        password: 'unused',
        database: 'unused',
        entities: [AgentRunLog],
    });
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

    // The engine that evaluates the emitted SQL. Instants are fixed-width
    // text, so comparing two of them is comparing the instants; ids are
    // lower-case text, which orders exactly as Postgres orders a `uuid`.
    const engine = await new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
    }).initialize();
    await engine.query(
        'CREATE TABLE "agent_run_logs" ("id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "level" TEXT NOT NULL, "step" TEXT NOT NULL, "message" TEXT NOT NULL, "metadata" TEXT, "tenantId" TEXT, "organizationId" TEXT, "createdAt" TEXT NOT NULL)',
    );
    // `pg`'s own parser for `timestamp` (oid 1114): where the microseconds go.
    const parseTimestamp = pgTypes.getTypeParser(1114) as (text: string) => Date;

    const prototype = SelectQueryBuilder.prototype as unknown as {
        loadRawResults(this: SelectQueryBuilder<ObjectLiteral>, runner: unknown): Promise<unknown>;
    };
    const original = prototype.loadRawResults;
    const spy = jest.spyOn(prototype, 'loadRawResults').mockImplementation(async function (
        this: SelectQueryBuilder<ObjectLiteral>,
        runner: unknown,
    ) {
        if (this.connection !== dataSource) return original.call(this, runner);
        const [sql, parameters] = this.getQueryAndParameters();
        const bound: unknown[] = [];
        const statement = sql.replace(/\$(\d+)/g, (_placeholder, index: string) => {
            const value: unknown = parameters[Number(index) - 1];
            // A `Date` crosses the wire as the text `pg` renders for it.
            bound.push(
                value instanceof Date
                    ? postgresTimestampInput(prepareValue(value) as string)
                    : value,
            );
            return '?';
        });
        const rows = (await engine.query(statement, bound)) as Array<Record<string, unknown>>;
        return rows.map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    typeof value === 'string' && STORED_INSTANT.test(value)
                        ? parseTimestamp(value)
                        : value,
                ]),
            ),
        );
    });

    return {
        logs: new AgentRunLogRepository(dataSource.getRepository(AgentRunLog)),
        async seed(rows) {
            for (const row of rows) {
                await engine.query(`${INSERT_ROW}(?, ?, 'INFO', ?, ?, ?)`, [
                    row.id,
                    row.runId,
                    row.step,
                    row.id,
                    row.createdAt,
                ]);
            }
        },
        async remove(id) {
            await engine.query('DELETE FROM "agent_run_logs" WHERE "id" = ?', [id]);
        },
        async storedInstant(id) {
            const [row] = (await engine.query(
                'SELECT "createdAt" FROM "agent_run_logs" WHERE "id" = ?',
                [id],
            )) as Array<{ createdAt: string }>;
            return row.createdAt;
        },
        async reset() {
            await engine.query('DELETE FROM "agent_run_logs"');
        },
        async close() {
            spy.mockRestore();
            await engine.destroy();
        },
    };
}

async function realPostgresStore(url: string): Promise<TimelineStore> {
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1)).toLowerCase();
    if (!/(^|[-_])test($|[-_])/.test(databaseName)) {
        throw new Error(
            'EVER_WORKS_POSTGRES_TIMELINE_TEST_URL must point to a dedicated database whose name contains "test"',
        );
    }
    const dataSource = await new DataSource({
        type: 'postgres',
        url,
        entities: [AgentRunLog],
        synchronize: true,
        dropSchema: true,
    }).initialize();

    return {
        logs: new AgentRunLogRepository(dataSource.getRepository(AgentRunLog)),
        async seed(rows) {
            for (const row of rows) {
                await dataSource.query(`${INSERT_ROW}($1, $2, 'INFO', $3, $4, $5)`, [
                    row.id,
                    row.runId,
                    row.step,
                    row.id,
                    row.createdAt,
                ]);
            }
        },
        async remove(id) {
            await dataSource.query('DELETE FROM "agent_run_logs" WHERE "id" = $1', [id]);
        },
        async storedInstant(id) {
            const [row] = (await dataSource.query(
                `SELECT to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.US') AS "instant" FROM "agent_run_logs" WHERE "id" = $1`,
                [id],
            )) as Array<{ instant: string }>;
            return row.instant;
        },
        async reset() {
            await dataSource.query('DELETE FROM "agent_run_logs"');
        },
        async close() {
            await dataSource.destroy();
        },
    };
}

function controllerOver(logs: AgentRunLogRepository): AgentsController {
    const run = {
        id: RUN,
        agentId: '00000000-0000-4000-8000-000000000001',
        userId: 'u1',
        status: 'succeeded',
        triggerKind: 'task',
        startedAt: new Date('2026-09-17T09:00:00.000Z'),
        finishedAt: new Date('2026-09-17T09:05:00.000Z'),
        workspaceMeta: null,
        changedFilesCount: 0,
        chatMessageId: null,
        memorySessionId: null,
        createdAt: new Date('2026-09-17T08:59:00.000Z'),
    };
    return new AgentsController(
        { getOne: jest.fn().mockResolvedValue({ id: run.agentId }) } as never, // service
        {} as never, // files
        {} as never, // exportService
        {} as never, // dispatcher
        { findByIdAndUser: jest.fn().mockResolvedValue(run) } as never, // agentRuns
        logs,
        {} as never, // skillBindings
        {} as never, // pluginUsage
        {} as never, // tasks
        undefined, // activityLog
        undefined, // heartbeatTrigger
        undefined, // taskExecuteDispatcher
    );
}

interface Walk {
    /** False when the bound was hit: the pager never reached a null `nextCursor`. */
    terminated: boolean;
    /** Row ids, page by page. */
    pages: string[][];
    /** Every non-null `nextCursor`, in the order they were handed out. */
    cursors: string[];
}

/**
 * Follow `nextCursor` until it is null, as a client does. A correct walk
 * needs at most one request per row plus the final empty page, so twice
 * that is a generous bound that still turns a loop into a failure.
 */
async function walk(
    controller: AgentsController,
    runId: string,
    limit: number,
    rowCount: number,
    from?: string,
): Promise<Walk> {
    const result: Walk = { terminated: false, pages: [], cursors: [] };
    let cursor = from;
    for (let request = 0; request < 2 * (rowCount + 1); request += 1) {
        const detail = await controller.getRunSessionDetail({ userId: 'u1' } as never, runId, {
            limit,
            cursor,
        });
        const { entries, nextCursor } = detail.timeline;
        result.pages.push(entries.map((entry) => entry.id));
        if (nextCursor === null) {
            result.terminated = true;
            break;
        }
        // The cursor names the page's last row, in the wire shape the edge
        // validates — unchanged by the fix.
        expect(nextCursor).toBe(entries[entries.length - 1].cursor);
        expect(nextCursor).toMatch(AGENT_RUN_TIMELINE_CURSOR_PATTERN);
        result.cursors.push(nextCursor);
        cursor = nextCursor;
    }
    return result;
}

function expectCompleteWalk(walked: Walk, expected: readonly string[]): void {
    // (a) It ends. On failure this names the cursor it was stuck on.
    expect(
        walked.terminated
            ? 'ended'
            : `still paging after ${walked.pages.length} requests; last cursors ${JSON.stringify(
                  walked.cursors.slice(-3),
              )}; last pages ${JSON.stringify(walked.pages.slice(-3))}`,
    ).toBe('ended');
    // (b) The cursor moves on every step: no cursor is ever handed out twice.
    expect(
        walked.cursors.filter((cursor, index) => walked.cursors.indexOf(cursor) < index),
    ).toEqual([]);
    // (c) Every row exactly once, in timeline order.
    expect(walked.pages.flat()).toEqual(expected);
}

function describeTimelineWalk(storeName: string, createStore: () => Promise<TimelineStore>): void {
    describe(`AgentsController — session detail paged to the end (${storeName})`, () => {
        let store: TimelineStore;
        let controller: AgentsController;

        beforeAll(async () => {
            store = await createStore();
            controller = controllerOver(store.logs);
        });

        afterAll(async () => {
            await store?.close();
        });

        beforeEach(async () => {
            await store.reset();
        });

        it('stores microseconds, and the cursor the API mints names only the millisecond', async () => {
            // The premise every walk below depends on — if either half
            // stopped holding, these cases would pass for the wrong reason.
            await store.seed(PAIR);
            await expect(store.storedInstant(PAIR[0].id)).resolves.toBe(at('123100'));

            const detail = await controller.getRunSessionDetail({ userId: 'u1' } as never, RUN, {
                limit: 1,
            });

            const [entry] = detail.timeline.entries;
            expect(entry.id).toBe(PAIR[0].id);
            expect(entry.createdAt).toMatch(/\.123Z$/);
            expect(detail.timeline.nextCursor).toBe(entry.cursor);
        });

        it.each([1, 2, 3])(
            '⭐ walks a same-millisecond message + tool call to the end at limit=%i',
            async (limit) => {
                await store.seed(PAIR);

                const walked = await walk(controller, RUN, limit, PAIR.length);

                expectCompleteWalk(walked, timelineOrder(PAIR));
            },
        );

        it.each([1, 2, 3, 4])(
            '⭐ walks a same-millisecond burst (with a shared microsecond) to the end at limit=%i',
            async (limit) => {
                await store.seed(BURST);

                const walked = await walk(controller, RUN, limit, BURST.length);

                expectCompleteWalk(walked, timelineOrder(BURST));
            },
        );

        it('⭐ still reaches every remaining row when the cursor row has been deleted', async () => {
            // The one case the anchor cannot be read: the cursor then
            // counts from the start of the millisecond it names, and the
            // next cursor names a row that exists again.
            await store.seed(PAIR);
            const [first, second, third] = timelineOrder(PAIR);
            const opening = await controller.getRunSessionDetail({ userId: 'u1' } as never, RUN, {
                limit: 1,
            });
            expect(opening.timeline.entries.map((entry) => entry.id)).toEqual([first]);
            expect(opening.timeline.nextCursor).not.toBeNull();

            await store.remove(first);
            const walked = await walk(
                controller,
                RUN,
                1,
                PAIR.length,
                opening.timeline.nextCursor as string,
            );

            expectCompleteWalk(walked, [second, third]);
        });

        it('⭐ never anchors on a row of another run: that cursor widens instead of skipping', async () => {
            // A row of ANOTHER run, stored between this run's pair and its
            // reply. Anchoring on it would silently drop the pair; scoped to
            // the run it is "not found", and the millisecond it names is
            // honoured from its start.
            await store.seed(PAIR);
            const foreign: SeedRow = {
                id: uuid('99'),
                runId: OTHER_RUN,
                step: 'assistant-message',
                createdAt: at('123950'),
            };
            await store.seed([foreign]);
            const foreignDetail = await controller.getRunSessionDetail(
                { userId: 'u1' } as never,
                OTHER_RUN,
                { limit: 1 },
            );
            expect(foreignDetail.timeline.entries.map((entry) => entry.id)).toEqual([foreign.id]);

            const detail = await controller.getRunSessionDetail({ userId: 'u1' } as never, RUN, {
                limit: 100,
                cursor: foreignDetail.timeline.entries[0].cursor,
            });

            expect(detail.timeline.entries.map((entry) => entry.id)).toEqual(timelineOrder(PAIR));
        });
    });
}

describeTimelineWalk('a microsecond model of the Postgres wire', microsecondModelStore);

const postgresUrl = process.env.EVER_WORKS_POSTGRES_TIMELINE_TEST_URL;
if (postgresUrl) {
    describeTimelineWalk('real Postgres', () => realPostgresStore(postgresUrl));
} else {
    describe.skip('AgentsController — session detail paged to the end (real Postgres)', () => {
        it('needs EVER_WORKS_POSTGRES_TIMELINE_TEST_URL', () => undefined);
    });
}

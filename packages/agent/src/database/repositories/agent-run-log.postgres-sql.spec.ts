import { DataSource, SelectQueryBuilder, type Repository } from 'typeorm';
import { AgentRunLog } from '../../entities/agent-run-log.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunLogRepository } from './agent-run-log.repository';

/**
 * Session detail (Feature K) — the SQL the timeline page emits on each
 * driver.
 *
 * The fix for the whole-second cursor is per-driver, and the risk of a
 * per-driver fix is that it quietly changes the other driver. So this pins
 * both halves: Postgres keeps the `(instant, id)` keyset on the raw
 * microsecond `timestamp` column — no canonical text key, no rowid
 * anywhere, every camelCase identifier quoted, and an id cursor anchored
 * on the cursor row's STORED instant rather than the millisecond the
 * cursor names — while the sqlite family,
 * whose column is whole-second TEXT and whose tie-break IS insertion
 * order, orders equal timestamps by that `rowid` and carries the same
 * column in its cursor predicate.
 *
 * The starred Postgres case is the one that bites: a millisecond-truncated
 * sort key is only safe where the tie-break is monotonic with insertion
 * order, and Postgres's tie-break is a random uuid v4.
 *
 * No database is needed: the repository runs over an unconnected
 * DataSource with metadata built, and the terminal `getRawAndEntities` is
 * intercepted to capture `getQuery()`.
 */
describe('AgentRunLogRepository — per-driver SQL for the timeline page', () => {
    const RUN = '11111111-1111-4111-8111-111111111111';
    const AT = new Date('2026-09-17T16:52:05.123Z');
    const STEPS = ['assistant-message', 'tool-invocation'] as const;

    async function buildRepository(type: 'postgres' | 'better-sqlite3'): Promise<{
        logs: AgentRunLogRepository;
        orm: Repository<AgentRunLog>;
    }> {
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
        const orm = dataSource.getRepository(AgentRunLog);
        return { logs: new AgentRunLogRepository(orm), orm };
    }

    /** Run `call`, returning the SQL of the select it executed. */
    async function captureSql(call: () => Promise<unknown>): Promise<string> {
        const { sql } = await captureQuery(call);
        return sql;
    }

    /**
     * The same capture, keeping the BOUND PARAMETERS too.
     *
     * The SQL alone cannot see the defect these Postgres cases pin: an
     * integer bound against the `uuid` primary key renders as the same
     * `"log"."id" > :param` text a uuid does, and only fails once the
     * driver binds it.
     */
    async function captureQuery(
        call: () => Promise<unknown>,
    ): Promise<{ sql: string; parameters: Record<string, unknown> }> {
        const captured: Array<{ sql: string; parameters: Record<string, unknown> }> = [];
        const spy = jest
            .spyOn(SelectQueryBuilder.prototype, 'getRawAndEntities')
            .mockImplementation(function (this: SelectQueryBuilder<AgentRunLog>) {
                captured.push({ sql: this.getQuery(), parameters: this.getParameters() });
                return Promise.resolve({ entities: [], raw: [] });
            });
        try {
            await call();
        } finally {
            spy.mockRestore();
        }
        expect(captured).toHaveLength(1);
        return captured[0];
    }

    let postgres: Awaited<ReturnType<typeof buildRepository>>;
    let sqlite: Awaited<ReturnType<typeof buildRepository>>;

    beforeAll(async () => {
        postgres = await buildRepository('postgres');
        sqlite = await buildRepository('better-sqlite3');
    });

    afterEach(() => jest.restoreAllMocks());

    describe('on Postgres', () => {
        /**
         * Every millisecond-truncating rendering of the instant. The
         * timeline page must contain NONE of them on Postgres: see the
         * starred case below.
         */
        const TRUNCATED = [`to_char(`, `HH24:MI:SS.MS`, `strftime(`];

        /**
         * The cursor row's STORED instant, looked up by the id half of the
         * cursor and scoped to the run being read.
         */
        const ANCHOR = `(SELECT "timelineAnchor"."createdAt" AS "timelineAnchor_createdAt" FROM "agent_run_logs" "timelineAnchor" WHERE "timelineAnchor"."id" = :afterId AND "timelineAnchor"."runId" = :runId)`;
        /** Strictly after the anchor row; the cursor's millisecond only when it is gone. */
        const ANCHORED = `AND ("log"."createdAt" > ${ANCHOR} OR ("log"."createdAt" = ${ANCHOR} AND "log"."id" > :afterId) OR (${ANCHOR} IS NULL AND "log"."createdAt" >= :afterCreatedAt))`;

        it('orders and pages on the microsecond timestamp column, tie-broken by id', async () => {
            const emitted = await captureSql(() =>
                postgres.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT, id: 'log-42' }),
            );

            expect(emitted).toContain(ANCHORED);
            expect(emitted).toContain(`ORDER BY "log"."createdAt" ASC, "log"."id" ASC LIMIT 100`);
            // The sqlite-only insertion-order key must never reach Postgres.
            expect(emitted).not.toContain('rowid');
            // An unquoted `log.createdAt` would be a lower-cased, non-existent
            // column on Postgres.
            expect(emitted).not.toMatch(/(^|[^"])\blog\.[a-zA-Z]+/);
        });

        it('⭐ anchors an id cursor on the stored row, never on the millisecond it names', async () => {
            // The loop this case exists for. `pg` builds the cursor row's
            // `Date` with its microseconds cut off, so `:afterCreatedAt` is
            // `.123` for a row stored at `.123456` — and that row satisfies
            // `"log"."createdAt" > :afterCreatedAt` again. A full page whose
            // rows share the last row's millisecond (every page at
            // `limit=1`) then comes back identical, with the identical
            // `nextCursor`, forever. The walk itself is exercised end to
            // end in `apps/api`'s `agents.controller.session-detail.paging.spec.ts`.
            const id = '00000000-0000-4000-8000-00000000cc62';
            const { sql, parameters } = await captureQuery(() =>
                postgres.logs.findTimelinePage(RUN, STEPS, 1, { createdAt: AT, id }),
            );

            expect(sql).toContain(ANCHORED);
            // The truncated instant is never the keyset's lower bound while
            // the cursor row can be found.
            expect(sql).not.toContain(`"log"."createdAt" > :afterCreatedAt`);
            expect(sql).not.toContain(`"log"."createdAt" = :afterCreatedAt`);
            expect(parameters).toMatchObject({ runId: RUN, afterId: id, afterCreatedAt: AT });
        });

        it('⭐ never truncates the timeline instant to the millisecond a cursor names', async () => {
            // The regression this case exists for. `agent_run_logs.createdAt`
            // is `timestamp DEFAULT now()` — microseconds — and each
            // `append()` commits its own transaction, so an
            // `assistant-message` row and the `tool-invocation` row it
            // triggered land a few hundred microseconds apart INSIDE one
            // millisecond. Ordering the page on a millisecond-truncated key
            // collapses them to the same key and leaves the tie-break to
            // decide, and Postgres's tie-break is a random uuid v4 — so the
            // transcript renders the tool call above the assistant message
            // that requested it, and two rejected calls in one round in
            // arbitrary order. The column's own resolution is the only
            // ordering that is chronological here.
            // Sequentially: each capture installs and restores its own spy
            // on the shared `SelectQueryBuilder.prototype`.
            const pages: string[] = [];
            pages.push(await captureSql(() => postgres.logs.findTimelinePage(RUN, STEPS, 100)));
            pages.push(
                await captureSql(() =>
                    postgres.logs.findTimelinePage(RUN, STEPS, 100, {
                        createdAt: AT,
                        id: '00000000-0000-4000-8000-00000000cc62',
                    }),
                ),
            );
            pages.push(
                await captureSql(() =>
                    postgres.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT }),
                ),
            );

            for (const emitted of pages) {
                for (const truncation of TRUNCATED) {
                    expect(emitted).not.toContain(truncation);
                }
                expect(emitted).toContain(`ORDER BY "log"."createdAt" ASC, "log"."id" ASC`);
            }
        });

        it('needs no cursor predicate on the first page', async () => {
            const emitted = await captureSql(() => postgres.logs.findTimelinePage(RUN, STEPS, 100));

            expect(emitted).not.toContain(':afterCreatedAt');
            expect(emitted).toContain('LIMIT 100');
        });

        it('⭐ widens an insertion-order cursor instead of binding it to the uuid id', async () => {
            // The tie-break Postgres orders by is the row's uuid id, so an
            // integer insertion-order key — what the sqlite family hands
            // out, and what the edge accepts so a cursor survives a store
            // change mid-session — is not a position here. Binding it
            // anyway is `invalid input syntax for type uuid`, i.e. an HTTP
            // 500 for a request that is merely un-resumable. Widening to
            // the cursor's millisecond repeats rows, never skips them.
            const { sql, parameters } = await captureQuery(() =>
                postgres.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT, tieBreak: '42' }),
            );

            expect(sql).toContain(`AND "log"."createdAt" >= :afterCreatedAt`);
            expect(sql).not.toContain(':afterTieBreak');
            expect(sql).not.toContain('"log"."id" >');
            expect(Object.keys(parameters)).not.toContain('afterTieBreak');
            expect(Object.keys(parameters)).not.toContain('afterId');
            expect(parameters.afterCreatedAt).toBe(AT);
        });

        it("⭐ falls back to the id half when the tie-break half is not this store's", async () => {
            // Both halves set is what a client mid-migration sends. The id
            // is the half Postgres can compare, so the page stays EXACT
            // rather than widening.
            const id = '00000000-0000-4000-8000-00000000cc62';
            const { sql, parameters } = await captureQuery(() =>
                postgres.logs.findTimelinePage(RUN, STEPS, 100, {
                    createdAt: AT,
                    tieBreak: '42',
                    id,
                }),
            );

            expect(sql).toContain(ANCHORED);
            expect(sql).not.toContain(':afterTieBreak');
            expect(parameters.afterId).toBe(id);
            expect(Object.values(parameters)).not.toContain('42');
        });

        it('⭐ binds no empty row id when the cursor names no comparable position', async () => {
            // `AgentRunTimelineCursor.id` is optional, and an empty string
            // is as invalid a uuid as an integer is.
            const { sql, parameters } = await captureQuery(() =>
                postgres.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT }),
            );

            expect(sql).toContain(`AND "log"."createdAt" >= :afterCreatedAt`);
            expect(sql).not.toContain(':afterId');
            expect(Object.values(parameters)).not.toContain('');
        });
    });

    describe('on better-sqlite3', () => {
        it('orders equal timestamps by insertion order and pages on that same column', async () => {
            const emitted = await captureSql(() =>
                sqlite.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT, tieBreak: '7' }),
            );

            const key = `strftime('%Y-%m-%dT%H:%M:%f', "log"."createdAt")`;
            const cursorKey = `strftime('%Y-%m-%dT%H:%M:%f', :afterCreatedAt)`;
            expect(emitted).toContain(
                `AND (${key} > ${cursorKey} OR (${key} = ${cursorKey} AND "log".rowid > :afterTieBreak))`,
            );
            expect(emitted).toContain(`ORDER BY ${key} ASC, "log".rowid ASC`);
            // `limit`, never `take`: a raw rowid order key cannot be resolved
            // inside TypeORM's distinct-id pagination sub-query.
            expect(emitted).toContain('LIMIT 100');
        });

        it('widens an id-shaped cursor to the start of its millisecond', async () => {
            const emitted = await captureSql(() =>
                sqlite.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT, id: 'log-42' }),
            );

            const key = `strftime('%Y-%m-%dT%H:%M:%f', "log"."createdAt")`;
            expect(emitted).toContain(
                `AND ${key} >= strftime('%Y-%m-%dT%H:%M:%f', :afterCreatedAt)`,
            );
            // Comparing a row id against the rowid order key would be the one
            // way this could skip a row.
            expect(emitted).not.toContain(':afterId');
        });
    });
});

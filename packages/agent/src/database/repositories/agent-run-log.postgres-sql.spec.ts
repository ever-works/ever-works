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
 * both halves: Postgres keeps the `(instant, id)` keyset with NO rowid
 * anywhere and every camelCase identifier quoted, while the sqlite family
 * orders equal timestamps by insertion order and carries that same column
 * in its cursor predicate.
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
        const captured: string[] = [];
        const spy = jest
            .spyOn(SelectQueryBuilder.prototype, 'getRawAndEntities')
            .mockImplementation(function (this: SelectQueryBuilder<AgentRunLog>) {
                captured.push(this.getQuery());
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
        it('orders and pages on the canonical millisecond key, tie-broken by id', async () => {
            const emitted = await captureSql(() =>
                postgres.logs.findTimelinePage(RUN, STEPS, 100, { createdAt: AT, id: 'log-42' }),
            );

            const key = `to_char("log"."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
            const cursorKey = `to_char(CAST(:afterCreatedAt AS timestamp), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
            expect(emitted).toContain(
                `AND (${key} > ${cursorKey} OR (${key} = ${cursorKey} AND "log"."id" > :afterId))`,
            );
            expect(emitted).toContain(`ORDER BY ${key} ASC, "log"."id" ASC LIMIT 100`);
            // The sqlite-only insertion-order key must never reach Postgres.
            expect(emitted).not.toContain('rowid');
            // An unquoted `log.createdAt` would be a lower-cased, non-existent
            // column on Postgres.
            expect(emitted).not.toMatch(/(^|[^"])\blog\.[a-zA-Z]+/);
        });

        it('needs no cursor predicate on the first page', async () => {
            const emitted = await captureSql(() => postgres.logs.findTimelinePage(RUN, STEPS, 100));

            expect(emitted).not.toContain(':afterCreatedAt');
            expect(emitted).toContain('LIMIT 100');
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

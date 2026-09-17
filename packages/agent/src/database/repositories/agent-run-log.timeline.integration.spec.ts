import { DataSource } from 'typeorm';
import { AgentRunLog } from '@src/entities/agent-run-log.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunLogRepository } from './agent-run-log.repository';

/**
 * Session detail (Feature K) — the run-timeline keyset page, executed
 * against a real better-sqlite3 database rather than a mocked query
 * builder.
 *
 * What a mock cannot see is the whole defect: on the sqlite family
 * `@CreateDateColumn()` with no explicit type is TEXT defaulted by
 * `datetime('now')`, so every row appended inside one second carries the
 * SAME whole-second timestamp — `'2026-09-17 16:52:05'` — while a bound JS
 * `Date` serialises to `'2026-09-17 16:52:05.123'`. A cursor that binds a
 * `Date` therefore compares two different string shapes and silently drops
 * every row that shares the cursor's second, and `id` (random uuid v4)
 * cannot order the rows inside that second chronologically.
 *
 * better-sqlite3 is what the shipped demo/self-host compose profile, the
 * desktop/CLI app and the whole CI + e2e stack run on, so this is the
 * driver the reader actually meets.
 */
describe('AgentRunLogRepository — session-detail timeline paging (integration)', () => {
    let dataSource: DataSource;
    let logs: AgentRunLogRepository;

    const RUN = '11111111-1111-4111-8111-111111111111';
    const OTHER_RUN = '22222222-2222-4222-8222-222222222222';
    const STEPS = ['assistant-message', 'user-message', 'tool-invocation'] as const;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        logs = new AgentRunLogRepository(dataSource.getRepository(AgentRunLog));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(AgentRunLog).clear();
    });

    /**
     * Append through the REAL repository, i.e. with `createdAt` left to the
     * column default, then force the stored value to the whole second
     * `datetime('now')` writes. Pinning the second is what makes the test
     * deterministic — the defect only shows when several rows share one —
     * and it is written in the same TEXT shape the default produces, so the
     * row is indistinguishable from one the running system wrote.
     */
    async function append(message: string, second: string): Promise<string> {
        const row = await logs.append({
            runId: RUN,
            level: 'INFO',
            step: 'assistant-message',
            message,
        });
        await dataSource.query('UPDATE agent_run_logs SET createdAt = ? WHERE id = ?', [
            second,
            row.id,
        ]);
        return row.id;
    }

    /** Walk every page with `limit`, returning the messages in page order. */
    async function walk(limit: number): Promise<{ pages: string[][]; all: string[] }> {
        const pages: string[][] = [];
        let after: Parameters<typeof logs.findTimelinePage>[3];
        // Bounded so an infinite-loop regression fails loudly instead of hanging.
        for (let guard = 0; guard < 20; guard += 1) {
            const page = await logs.findTimelinePage(RUN, STEPS, limit, after);
            pages.push(page.rows.map((row) => row.message));
            if (page.rows.length < limit) break;
            const last = page.rows[page.rows.length - 1];
            after = { createdAt: last.createdAt, tieBreak: page.tieBreaks.get(last.id) };
        }
        return { pages, all: pages.flat() };
    }

    it('⭐ reaches every row of a whole-second burst, in insertion order', async () => {
        // Five rows inside one second, three in the next — the exact shape
        // `datetime('now')` produces for a tool round plus its replies.
        const first = ['a', 'b', 'c', 'd', 'e'];
        const second = ['f', 'g', 'h'];
        for (const message of first) await append(message, '2026-09-17 16:52:05');
        for (const message of second) await append(message, '2026-09-17 16:52:06');

        const { pages, all } = await walk(4);

        // Nothing skipped, nothing repeated, and the burst is chronological:
        // before the fix page 1 was a uuid-shuffled ['a','d','b','c'] and page
        // 2 came back EMPTY, so the API reported the transcript complete at 4
        // of 8 rows.
        expect(all).toEqual([...first, ...second]);
        expect(pages[0]).toEqual(['a', 'b', 'c', 'd']);
        expect(pages[1]).toEqual(['e', 'f', 'g', 'h']);
    });

    it('keeps a live-follow poll advancing inside one second', async () => {
        // The live path re-reads with the last on-screen row's cursor every
        // 5s. Every row appended during that same second must still arrive.
        for (const message of ['a', 'b']) await append(message, '2026-09-17 16:52:05');
        const seen = await logs.findTimelinePage(RUN, STEPS, 100);
        expect(seen.rows.map((row) => row.message)).toEqual(['a', 'b']);
        const last = seen.rows[seen.rows.length - 1];

        for (const message of ['c', 'd']) await append(message, '2026-09-17 16:52:05');
        const fresh = await logs.findTimelinePage(RUN, STEPS, 100, {
            createdAt: last.createdAt,
            tieBreak: seen.tieBreaks.get(last.id),
        });

        expect(fresh.rows.map((row) => row.message)).toEqual(['c', 'd']);
    });

    it('honours a cursor minted before the tie-break by repeating, never skipping', async () => {
        for (const message of ['a', 'b', 'c']) await append(message, '2026-09-17 16:52:05');
        await append('d', '2026-09-17 16:52:06');
        const page = await logs.findTimelinePage(RUN, STEPS, 100);
        const middle = page.rows[1];

        // `{ createdAt, id }` is the old cursor shape a browser may still
        // hold: it names the instant but not the position inside it.
        const resumed = await logs.findTimelinePage(RUN, STEPS, 100, {
            createdAt: middle.createdAt,
            id: middle.id,
        });

        const messages = resumed.rows.map((row) => row.message);
        // Everything at or after the named second, so nothing is lost; the
        // rows already on screen are re-sent and de-duplicated by id.
        expect(messages).toEqual(['a', 'b', 'c', 'd']);
        // …and the cursor it hands back is the exact form again.
        const last = resumed.rows[resumed.rows.length - 1];
        expect(resumed.tieBreaks.get(last.id)).toMatch(/^\d+$/);
    });

    it('⭐ widens a tie-break minted by another store rather than skipping the page', async () => {
        // The mirror of the case above: a cursor whose tie-break half is a
        // uuid row id — the shape every non-sqlite store hands out —
        // arriving at a store whose tie-break column is the integer
        // `rowid`. Coercing it to a number yields NaN, and `rowid > NaN`
        // matches NOTHING: the page comes back empty and the caller is told
        // the transcript ended. Widening to the cursor's instant is the
        // same repeat-never-skip treatment an id-shaped cursor gets.
        for (const message of ['a', 'b', 'c']) await append(message, '2026-09-17 16:52:05');
        await append('d', '2026-09-17 16:52:06');
        const page = await logs.findTimelinePage(RUN, STEPS, 100);
        const middle = page.rows[1];

        const resumed = await logs.findTimelinePage(RUN, STEPS, 100, {
            createdAt: middle.createdAt,
            tieBreak: middle.id,
        });

        expect(resumed.rows.map((row) => row.message)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('never reads another run, and still short-circuits an empty step list', async () => {
        await append('mine', '2026-09-17 16:52:05');
        const otherRepository = dataSource.getRepository(AgentRunLog);
        await otherRepository.save(
            otherRepository.create({
                runId: OTHER_RUN,
                level: 'INFO',
                step: 'assistant-message',
                message: 'theirs',
            }),
        );

        const page = await logs.findTimelinePage(RUN, STEPS, 100);

        expect(page.rows.map((row) => row.message)).toEqual(['mine']);
        await expect(logs.findTimelinePage(RUN, [], 100)).resolves.toEqual({
            rows: [],
            tieBreaks: new Map(),
        });
    });
});

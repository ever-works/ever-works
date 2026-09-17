import type { Repository } from 'typeorm';
import type { ActivityLog } from '../../entities/activity-log.entity';
import { ActivityLogRepository } from './activity-log.repository';

/**
 * The Live Feed query shape, asserted on a recording query builder. The
 * behaviour over real rows is pinned by
 * `activity-log.repository.feed.integration.spec.ts` on better-sqlite3; this
 * spec covers what that driver cannot reach — the Postgres branch that keeps
 * the cursor microsecond-precise, and the portable branch every driver outside
 * those two families takes — and that no OFFSET is ever used.
 */

/**
 * What each driver's own `escape()` does to an identifier, so the harness
 * renders the expression the real builder would: double quotes on Postgres and
 * the sqlite family, backticks on MySQL/MariaDB — where a double-quoted token
 * is a string literal, not a column.
 */
function escapeFor(driver: string, name: string): string {
    return driver === 'mysql' || driver === 'mariadb' ? `\`${name}\`` : `"${name}"`;
}

function queryHarness(driver: string, raw: Array<Record<string, unknown>>, entities: unknown[]) {
    const predicates: string[] = [];
    const parameters: Record<string, unknown>[] = [];
    const selects: string[] = [];
    /** Only the expressions aliased `feed_sort_key`, in call order. */
    const sortKeySelects: string[] = [];
    const record = (predicate: unknown, params?: Record<string, unknown>) => {
        if (typeof predicate === 'string') predicates.push(predicate);
        if (params) parameters.push(params);
    };
    const query = {
        leftJoin: jest.fn().mockReturnThis(),
        escape: jest.fn((name: string) => escapeFor(driver, name)),
        addSelect: jest.fn((selection: string | string[], alias?: string) => {
            selects.push(...(Array.isArray(selection) ? selection : [selection]));
            if (alias === 'feed_sort_key' && typeof selection === 'string') {
                sortKeySelects.push(selection);
            }
            return query;
        }),
        where: jest.fn((predicate: unknown, params?: Record<string, unknown>) => {
            record(predicate, params);
            return query;
        }),
        andWhere: jest.fn((predicate: unknown, params?: Record<string, unknown>) => {
            record(predicate, params);
            return query;
        }),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn(async () => ({ raw, entities })),
    };
    const repository = {
        createQueryBuilder: jest.fn(() => query),
        manager: { connection: { options: { type: driver } } },
    } as unknown as Repository<ActivityLog>;
    return { repository, query, predicates, parameters, selects, sortKeySelects };
}

const SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const ROW_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROW_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('ActivityLogRepository.findFeedPage (query shape)', () => {
    it('on Postgres, compares the cursor as microsecond text and returns the exact sort keys', async () => {
        const entities = [
            { id: ROW_A, createdAt: new Date('2026-09-13T11:00:00.654Z') },
            { id: ROW_B, createdAt: new Date('2026-09-13T10:00:00.000Z') },
        ];
        const harness = queryHarness(
            'postgres',
            [
                { activity_id: ROW_A, feed_sort_key: '2026-09-13T11:00:00.654321' },
                { activity_id: ROW_B, feed_sort_key: '2026-09-13T10:00:00.000001' },
            ],
            entities,
        );
        const repository = new ActivityLogRepository(harness.repository);

        const page = await repository.findFeedPage(
            {
                userId: 'user-1',
                cursor: { createdAt: '2026-09-13T12:00:00.123456', id: ROW_A },
                since: new Date('2026-06-15T00:00:00.000Z'),
                limit: 1,
            },
            SCOPE,
        );

        expect(harness.sortKeySelects).toEqual([
            `to_char(activity."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
        ]);
        expect(Object.assign({}, ...harness.parameters)).toMatchObject({
            feedUserId: 'user-1',
            feedCursorCreatedAt: '2026-09-13T12:00:00.123456',
            feedCursorId: ROW_A,
            feedOwnershipTenantId: SCOPE.tenantId,
            feedOwnershipOrganizationId: SCOPE.organizationId,
        });
        expect(harness.query.limit).toHaveBeenCalledWith(2);
        expect(harness.query.skip).not.toHaveBeenCalled();
        expect(harness.query.offset).not.toHaveBeenCalled();
        expect(page.rows.map((row) => row.id)).toEqual([ROW_A]);
        expect(page.hasMore).toBe(true);
        expect(page.sortKeys.get(ROW_A)).toBe('2026-09-13T11:00:00.654321');
    });

    it('on the sqlite family, binds the cursor as the stored text and takes the sort key from the column', async () => {
        // A row the column default timestamped: `datetime('now')` writes second
        // precision with NO fraction. Binding a JS `Date` renders '…:00.000',
        // which sorts AFTER that text, so the cursor row matches itself and the
        // page never advances. The bound value must be the stored form.
        const entities = [{ id: ROW_A, createdAt: new Date('2026-09-13T11:00:00.000Z') }];
        const harness = queryHarness(
            'better-sqlite3',
            [{ activity_id: ROW_A, feed_sort_key: '2026-09-13T11:00:00' }],
            entities,
        );
        const repository = new ActivityLogRepository(harness.repository);

        const page = await repository.findFeedPage(
            {
                userId: 'user-1',
                cursor: { createdAt: '2026-09-13T11:00:00', id: ROW_B },
                since: new Date('2026-06-15T00:00:00.000Z'),
                limit: 30,
            },
            { tenantId: null, organizationId: null },
        );

        const params = Object.assign({}, ...harness.parameters);
        expect(params.feedCursorCreatedAt).toBe('2026-09-13 11:00:00');
        expect(harness.selects.join('\n')).not.toContain('to_char');
        // Pinned for the sqlite family ONLY — this text form and this quoting
        // style are sqlite's, not "every driver that is not Postgres".
        expect(harness.sortKeySelects).toEqual([
            `replace(CAST(activity."createdAt" AS TEXT), ' ', 'T')`,
        ]);
        expect(harness.predicates.join('\n')).toContain(
            '(activity.organizationId IS NULL AND activity.tenantId IS NULL)',
        );
        expect(page.hasMore).toBe(false);
        expect(page.sortKeys.get(ROW_A)).toBe('2026-09-13T11:00:00');
    });

    it('mints no key at all for a row the store gave none for, rather than re-deriving one', async () => {
        // The key must always be the store's OWN text. Re-deriving it from the
        // hydrated `createdAt` would put back the very defect this guards:
        // `new Date(...).toISOString()` always pads a fraction, and on sqlite
        // '…:00.000' sorts AFTER the stored '…:00', so the cursor would match
        // its own row and the page would never advance. With no key,
        // `FeedService` mints no `nextCursor` and the feed ENDS instead.
        const entities = [{ id: ROW_A, createdAt: new Date('2026-09-13T11:00:00.000Z') }];
        const harness = queryHarness(
            'better-sqlite3',
            [{ activity_id: ROW_A, feed_sort_key: null }],
            entities,
        );
        const repository = new ActivityLogRepository(harness.repository);

        const page = await repository.findFeedPage(
            {
                userId: 'user-1',
                since: new Date('2026-06-15T00:00:00.000Z'),
                limit: 30,
            },
            { tenantId: null, organizationId: null },
        );

        expect(page.rows.map((row) => row.id)).toEqual([ROW_A]);
        expect(page.sortKeys.has(ROW_A)).toBe(false);
    });

    // `DatabaseType` is not two-valued: `mysql` and `mariadb` are wired in
    // `database.config.ts`, exported as `DatabaseConfigurations.mysql()` and
    // pinned by that module's own specs. Neither reads a double-quoted token as
    // an identifier (default `sql_mode` has ANSI_QUOTES off, so `"createdAt"`
    // is a string literal) and neither has a `TEXT` cast target, so the sqlite
    // expression is not a safe default for "everything that is not Postgres" —
    // it would make the FIRST feed read a parse error, not just paging.
    describe.each(['mysql', 'mariadb'])('on %s', (driver) => {
        it('emits no driver-specific sort-key SQL and binds the cursor as a Date', async () => {
            const entities = [
                { id: ROW_A, createdAt: new Date('2026-09-13T11:00:00.654Z') },
                { id: ROW_B, createdAt: new Date('2026-09-13T10:00:00.000Z') },
            ];
            // No `feed_sort_key` is selected, so the raw rows carry none.
            const harness = queryHarness(
                driver,
                [{ activity_id: ROW_A }, { activity_id: ROW_B }],
                entities,
            );
            const repository = new ActivityLogRepository(harness.repository);

            const page = await repository.findFeedPage(
                {
                    userId: 'user-1',
                    // The form the fallback key below mints, and which
                    // `decodeFeedCursor` accepts back.
                    cursor: { createdAt: '2026-09-13T12:00:00.123Z', id: ROW_B },
                    since: new Date('2026-06-15T00:00:00.000Z'),
                    limit: 1,
                },
                SCOPE,
            );

            expect(harness.sortKeySelects).toEqual([]);
            const selected = harness.selects.join('\n');
            expect(selected).not.toContain('to_char');
            expect(selected).not.toContain('CAST(');
            // A double-quoted identifier must never reach this driver.
            expect(selected).not.toContain('"');

            const params = Object.assign({}, ...harness.parameters);
            expect(params.feedCursorCreatedAt).toBeInstanceOf(Date);
            expect((params.feedCursorCreatedAt as Date).toISOString()).toBe(
                '2026-09-13T12:00:00.123Z',
            );

            // The key comes from the hydrated row here. Without it `sortKeys`
            // stays empty, `FeedService` mints `nextCursor: null`, and the feed
            // reports `hasMore: false` after its first page.
            expect(page.hasMore).toBe(true);
            expect(page.sortKeys.get(ROW_A)).toBe('2026-09-13T11:00:00.654Z');
        });
    });

    it.each([
        ['postgres', 'to_char'],
        ['better-sqlite3', 'replace'],
        ['sqlite', 'replace'],
        ['sqlite3', 'replace'],
        ['mysql', null],
        ['mariadb', null],
    ])(
        'discriminates %s three ways rather than "Postgres or else"',
        async (driver, expected: string | null) => {
            const harness = queryHarness(driver, [], []);
            const repository = new ActivityLogRepository(harness.repository);

            await repository.findFeedPage(
                {
                    userId: 'user-1',
                    since: new Date('2026-06-15T00:00:00.000Z'),
                    limit: 30,
                },
                { tenantId: null, organizationId: null },
            );

            if (expected === null) {
                expect(harness.sortKeySelects).toEqual([]);
            } else {
                expect(harness.sortKeySelects).toHaveLength(1);
                expect(harness.sortKeySelects[0]).toContain(expected);
                expect(harness.sortKeySelects[0]).toContain(`activity."createdAt"`);
            }
        },
    );
});

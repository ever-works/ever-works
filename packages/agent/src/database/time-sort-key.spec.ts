import type { SelectQueryBuilder } from 'typeorm';
import {
    isPostgresDriver,
    keysetTieBreakSql,
    timeSortKeyColumnSql,
    timeSortKeyParameterSql,
    timeSortKeyStrategy,
} from './time-sort-key';

/**
 * The building blocks of a portable keyset page. The behaviour that
 * matters against a real database is covered by
 * `repositories/agent-run-log.timeline.integration.spec.ts` and
 * `repositories/agent-run.ledger.integration.spec.ts`; what is pinned here
 * is the per-driver dispatch itself, including the two cases a caller must
 * handle: a driver with no canonical key, and a query builder with no
 * connection.
 */
describe('time-sort-key', () => {
    const SQLITE_FAMILY = [
        'better-sqlite3',
        'sqlite',
        'sqljs',
        'capacitor',
        'cordova',
        'expo',
        'nativescript',
        'react-native',
    ];

    describe('isPostgresDriver', () => {
        it('names the Postgres driver', () => {
            expect(isPostgresDriver('postgres')).toBe(true);
        });

        it.each([undefined, null, 'better-sqlite3', 'mysql', 'mariadb', 'cockroachdb', 42])(
            'does not claim %p',
            (type) => {
                expect(isPostgresDriver(type)).toBe(false);
            },
        );
    });

    describe('timeSortKeyStrategy', () => {
        // The rule the whole module turns on: truncating an ORDER BY down
        // to the millisecond a cursor names hands the ordering INSIDE that
        // millisecond to the tie-break column, so it is only safe where
        // that tie-break is insertion order.
        it.each(SQLITE_FAMILY)('truncates on %s, where the tie-break is rowid', (type) => {
            expect(timeSortKeyStrategy(type)).toBe('canonical-text');
        });

        it('⭐ keeps the native column on Postgres, whose tie-break is a random uuid', () => {
            // Regression guard. Ordering a Postgres timeline page on
            // `to_char(createdAt, '…SS.MS')` throws away the microseconds
            // the `timestamp` column stores and leaves rows written inside
            // one millisecond ordered by uuid v4 — the session transcript
            // renders a tool call above the assistant message that asked
            // for it. Only a DESCENDING keyset may truncate here, and it
            // reaches `timeSortKeyColumnSql` directly.
            expect(timeSortKeyStrategy('postgres')).toBe('native-column');
        });

        it.each([undefined, null, 'mysql', 'mariadb', 'mongodb', 42])(
            'leaves %p on the portable raw-column path',
            (type) => {
                expect(timeSortKeyStrategy(type)).toBe('portable-column');
            },
        );
    });

    describe('timeSortKeyColumnSql', () => {
        it.each(SQLITE_FAMILY)('renders whole-second %s text at millisecond width', (type) => {
            expect(timeSortKeyColumnSql(type, 'log.createdAt')).toBe(
                `strftime('%Y-%m-%dT%H:%M:%f', log.createdAt)`,
            );
        });

        it('truncates a Postgres microsecond column to the millisecond a cursor names', () => {
            expect(timeSortKeyColumnSql('postgres', 'COALESCE(run.startedAt, run.createdAt)')).toBe(
                `to_char(COALESCE(run.startedAt, run.createdAt), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`,
            );
        });

        it.each([undefined, null, 'mysql', 'mongodb', 42])(
            'leaves %p to the caller, so its existing predicate is unchanged',
            (type) => {
                expect(timeSortKeyColumnSql(type, 'log.createdAt')).toBeNull();
            },
        );
    });

    describe('timeSortKeyParameterSql', () => {
        it('renders a bound Date through the SAME function as the column on sqlite', () => {
            // Same function on both sides ⇒ whatever the driver does when it
            // serialises a Date, the two sides still agree.
            expect(timeSortKeyParameterSql('better-sqlite3', 'afterCreatedAt')).toBe(
                `strftime('%Y-%m-%dT%H:%M:%f', :afterCreatedAt)`,
            );
        });

        it('casts on Postgres, where a bare placeholder has no inferable type', () => {
            expect(timeSortKeyParameterSql('postgres', 'ledgerCursorAt')).toBe(
                `to_char(CAST(:ledgerCursorAt AS timestamp), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`,
            );
        });

        it('pairs with the column builder by also returning null', () => {
            expect(timeSortKeyParameterSql('mysql', 'ledgerCursorAt')).toBeNull();
        });
    });

    describe('keysetTieBreakSql', () => {
        const builder = (type?: string) =>
            ({
                alias: 'log',
                escape: (name: string) => `"${name}"`,
                connection: type ? { options: { type } } : undefined,
            }) as unknown as SelectQueryBuilder<{ id: string }>;

        it('breaks ties by insertion order on the sqlite family', () => {
            expect(keysetTieBreakSql(builder('better-sqlite3'), 'log.id')).toBe('"log".rowid');
        });

        it('breaks ties by row id everywhere else', () => {
            expect(keysetTieBreakSql(builder('postgres'), 'log.id')).toBe('log.id');
        });

        it('treats a connectionless builder (a unit-test mock) as "not sqlite"', () => {
            expect(keysetTieBreakSql(builder(), 'log.id')).toBe('log.id');
        });
    });
});

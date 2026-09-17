import { isSqliteFamilyDriver } from './insertion-order';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * Keyset (cursor) paging over a timestamp column, per driver.
 *
 * Why a text sort key and not the column itself: the same
 * `@CreateDateColumn()` renders at a DIFFERENT resolution on each driver,
 * and a cursor that binds a JS `Date` compares against the wrong thing on
 * both of them.
 *
 * - On the sqlite family (better-sqlite3 backs the shipped demo/self-host
 *   compose profile, the desktop/CLI app and the whole CI + e2e stack) an
 *   untyped `@CreateDateColumn()` is TEXT defaulted by `datetime('now')`,
 *   i.e. WHOLE SECONDS — `'2026-09-17 16:52:05'`. A bound `Date` is
 *   serialised by TypeORM as `'2026-09-17 16:52:05.123'`, a different
 *   string shape, so `createdAt > :date` silently drops every row that
 *   shares the cursor's second.
 * - On Postgres the column is a real `timestamp` with microsecond
 *   resolution, so a millisecond cursor is TOO COARSE: the cursor row
 *   itself still satisfies `>` (or `<`) and is served again on the next
 *   page.
 *
 * The fix is to compare a canonical, fixed-width, lexicographically
 * ordered text key on BOTH sides of the predicate, at the millisecond
 * resolution a cursor can actually name:
 *
 *     YYYY-MM-DDTHH:MM:SS.mmm      (23 characters, always)
 *
 * A whole-second sqlite row and a millisecond one canonicalise to the same
 * shape (`…05.000` / `…05.123`), so they order and compare correctly
 * against each other; a microsecond Postgres value is truncated to the
 * millisecond the cursor carries, which makes the cursor able to name an
 * exact position again. Ordering by the key is identical to ordering by
 * the column except INSIDE one millisecond, where the caller's tie-break
 * (see {@link keysetTieBreakSql}) decides — which is precisely where the
 * column alone cannot be paged.
 *
 * The cursor side is rendered by the SAME expression applied to the bound
 * `Date` ({@link timeSortKeyParameterSql}) rather than formatted in
 * JavaScript, so however a driver serialises a `Date` — UTC text on
 * sqlite, a local-offset literal on Postgres — the two sides of the
 * comparison always agree and no timezone assumption is needed.
 *
 * A driver we do not canonicalise (and a query builder with no connection,
 * i.e. a unit-test mock) returns `null` from both builders, so callers can
 * keep their previous raw-column predicate unchanged there.
 */

/** sqlite `%f` renders `SS.SSS`, so the format carries no separate `%S`. */
const SQLITE_KEY_FORMAT = '%Y-%m-%dT%H:%M:%f';

/** Postgres `MS` is the zero-padded millisecond part of the second. */
const POSTGRES_KEY_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS';

/**
 * SQL rendering a timestamp COLUMN as its canonical text sort key, or
 * `null` on a driver this module does not canonicalise.
 *
 * `columnSql` is any timestamp-valued expression in query-builder form
 * (`'log.createdAt'`, `'COALESCE(run.startedAt, run.createdAt)'`);
 * TypeORM rewrites the `alias.property` references inside it as usual.
 */
export function timeSortKeyColumnSql(driverType: unknown, columnSql: string): string | null {
    if (isSqliteFamilyDriver(driverType)) {
        return `strftime('${SQLITE_KEY_FORMAT}', ${columnSql})`;
    }
    if (driverType === 'postgres') {
        return `to_char(${columnSql}, '${POSTGRES_KEY_FORMAT}')`;
    }
    return null;
}

/**
 * SQL rendering a bound `Date` PARAMETER as the same canonical text sort
 * key {@link timeSortKeyColumnSql} produces for a column, or `null` on a
 * driver this module does not canonicalise.
 *
 * Pass the bare parameter name (`'afterCreatedAt'`); the `:` is added
 * here. Postgres needs the explicit cast because `to_char` is overloaded
 * and a bare placeholder has no inferable type.
 */
export function timeSortKeyParameterSql(driverType: unknown, parameterName: string): string | null {
    if (isSqliteFamilyDriver(driverType)) {
        return `strftime('${SQLITE_KEY_FORMAT}', :${parameterName})`;
    }
    if (driverType === 'postgres') {
        return `to_char(CAST(:${parameterName} AS timestamp), '${POSTGRES_KEY_FORMAT}')`;
    }
    return null;
}

/**
 * The column a keyset page breaks ties on inside one sort key.
 *
 * On the sqlite family that is the engine `rowid` — insertion order, the
 * only chronologically meaningful order available when several rows share
 * a whole-second `datetime('now')` timestamp (ids are random uuid v4, so
 * ordering by `id` there is deterministic but arbitrary). Everywhere else
 * it is the row's own id. See `insertion-order.ts` for the rowid caveats,
 * notably that the query must use `limit`/`offset` rather than
 * `take`/`skip` once a raw `rowid` is in its ORDER BY.
 *
 * A cursor must carry the value of THIS column, not always the row id:
 * the predicate's tie-break and the ORDER BY tie-break have to be the same
 * column or a page can skip rows.
 */
export function keysetTieBreakSql<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    idColumnSql: string,
): string {
    if (!isSqliteFamilyDriver(qb?.connection?.options?.type)) {
        return idColumnSql;
    }
    return `${qb.escape(qb.alias)}.rowid`;
}

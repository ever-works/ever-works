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
 * WHICH of those two a given read may use is not the driver's name but
 * the shape of its tie-break column — see {@link timeSortKeyStrategy},
 * which every ASCENDING keyset must ask before reaching for the builders
 * below. Truncating a Postgres column to the cursor's millisecond hands
 * the ordering inside that millisecond to a random uuid. The runs ledger
 * is a DESCENDING keyset and keeps the truncated key on purpose: there,
 * comparing the native column against a millisecond cursor would skip
 * rows instead of repeating them.
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
 * True when a TypeORM `DataSourceOptions.type` names the Postgres driver.
 *
 * The companion to {@link isSqliteFamilyDriver}: naming BOTH shipped
 * families is what lets a read discriminate three ways — this driver,
 * that driver, and the portable path everything else keeps — instead of
 * the two-way "postgres or else" that silently hands one driver's SQL to
 * every other one.
 */
export function isPostgresDriver(type: unknown): boolean {
    return type === 'postgres';
}

/**
 * Which form of the instant an ASCENDING keyset over a
 * `@CreateDateColumn()` may order and page on.
 *
 * Truncating the ORDER BY down to the millisecond a cursor can name does
 * not merely lose digits: it hands the ordering INSIDE one millisecond to
 * the keyset's tie-break column. Whether that is safe is a property of
 * that tie-break, not of the driver's name:
 *
 * - `'canonical-text'` — the sqlite family. `@CreateDateColumn()` is
 *   whole-second TEXT there, so the canonical key is the only thing that
 *   compares correctly at all, and the tie-break is the engine `rowid`
 *   (see {@link keysetTieBreakSql}), which IS insertion order. Truncating
 *   costs nothing: the order stays chronological.
 * - `'native-column'` — Postgres. The column is a real `timestamp`
 *   carrying microseconds while the tie-break is the row's random uuid v4
 *   primary key, so truncating to the cursor's millisecond would order
 *   rows written inside one millisecond by uuid — the session transcript
 *   then renders a tool call above the assistant message that requested
 *   it. The column therefore keeps its own resolution in both the ORDER
 *   BY and the keyset equality. That makes the cursor's millisecond
 *   useless as a lower bound: the cursor row's own microseconds still
 *   exceed it, so a page whose rows all share that millisecond would be
 *   served again with the identical cursor, forever. A keyset on this
 *   strategy must anchor on the cursor row's STORED instant instead —
 *   `AgentRunLogRepository.findTimelinePage` reads it with a sub-select
 *   by the cursor's id — and fall back to the millisecond (widened to its
 *   start: repeat, never skip) only when that row no longer exists.
 * - `'portable-column'` — every other driver, i.e. the raw-column
 *   predicate these reads have always emitted. Nothing is narrowed here.
 *
 * This answer is for ASCENDING keysets only. In a DESCENDING one a
 * millisecond cursor sits BELOW the cursor row's true microsecond instant,
 * so `native < cursor` EXCLUDES the older rows left in that millisecond
 * instead of repeating the newer ones, and they are skipped for good. The
 * runs ledger (`agent-run.repository.ts`'s `listLedgerPage`) is that case:
 * it keeps the truncated key, calling {@link timeSortKeyColumnSql}
 * directly rather than going through this.
 */
export type TimeSortKeyStrategy = 'canonical-text' | 'native-column' | 'portable-column';

/** The strategy {@link TimeSortKeyStrategy} documents, for one driver. */
export function timeSortKeyStrategy(driverType: unknown): TimeSortKeyStrategy {
    if (isSqliteFamilyDriver(driverType)) return 'canonical-text';
    if (isPostgresDriver(driverType)) return 'native-column';
    return 'portable-column';
}

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
    if (isPostgresDriver(driverType)) {
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
    if (isPostgresDriver(driverType)) {
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

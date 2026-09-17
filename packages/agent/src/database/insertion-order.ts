import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/** TypeORM driver types backed by an SQLite engine (every one has `rowid`). */
const SQLITE_FAMILY_DRIVERS: ReadonlySet<string> = new Set([
    'better-sqlite3',
    'sqlite',
    'sqljs',
    'capacitor',
    'cordova',
    'expo',
    'nativescript',
    'react-native',
]);

/** True when a TypeORM `DataSourceOptions.type` names an SQLite-family driver. */
export function isSqliteFamilyDriver(type: unknown): boolean {
    return typeof type === 'string' && SQLITE_FAMILY_DRIVERS.has(type);
}

/**
 * Break ties in a time ordering by insertion order, on SQLite only.
 *
 * Why SQLite needs it: `@CreateDateColumn` defaults to `datetime('now')`
 * there, which is TEXT with WHOLE-SECOND resolution. Every row inserted in
 * the same second carries the same `createdAt`, and SQLite returns equal
 * sort keys in whatever order the chosen index or temp B-tree yields — for
 * most plans that is the OLDEST inserted row first, so a
 * `ORDER BY createdAt DESC` "latest" read picks the wrong row.
 *
 * Why `rowid` and not the primary key: ids are random uuid v4 values, so
 * ordering by `id` is deterministic but not chronological. `rowid` is
 * assigned as `max(rowid) + 1` on every insert, so it follows insertion
 * order for legacy rows, bursts inside one second, and inserts from several
 * processes writing one database file. It survives TypeORM's
 * table-rebuild migrations and `VACUUM`: both copy the table with a full
 * scan, which walks rowid order, so any renumbering keeps the relative
 * order. A rowid freed by
 * deleting the newest row can be reused, but the reused value is again the
 * largest live one, so the newest row still sorts last.
 *
 * Caveats:
 * - The table must NOT be declared `WITHOUT ROWID`, and must not have its own
 *   column named `rowid`, `oid` or `_rowid_` (that column would shadow the
 *   engine's rowid).
 * - NEVER combine this with joins plus `take`/`skip`: TypeORM then paginates
 *   through a distinct-id sub-query whose ORDER BY is rebuilt from selected
 *   columns, and a raw `rowid` order key cannot be resolved there. Use
 *   `limit`/`offset`, or a join-free query, instead.
 *
 * Postgres and MySQL are left untouched: their timestamp columns are sub-second,
 * so the emitted SQL on those drivers stays exactly what it was. A query
 * builder without a connection (a unit-test mock) is returned unchanged too.
 */
export function addInsertionOrderTieBreak<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    direction: 'ASC' | 'DESC',
): SelectQueryBuilder<T> {
    if (!isSqliteFamilyDriver(qb?.connection?.options?.type)) {
        return qb;
    }
    return qb.addOrderBy(`${qb.escape(qb.alias)}.rowid`, direction);
}

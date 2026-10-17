import { Brackets, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { InvalidCursorError } from './integration-api.errors';

/**
 * Keyset paging for integration lists (EW-P1-4, contract v1 B.1):
 * `?updatedSince=<ISO>&cursor=<opaque>&limit=<≤500, default 200>`, ordered by
 * `(updatedAt, id)`, answering `{ data, nextCursor, hasMore }`.
 *
 * The cursor carries the `(updatedAt, id)` of the last row returned, with
 * `updatedAt` as the database's OWN fixed-width text of the stored value —
 * microseconds on Postgres and MySQL, milliseconds on SQLite — so the
 * comparison is exact at the column's precision: a row is never returned
 * twice, and rows of the same instant are never skipped (a JavaScript Date
 * would round Postgres microseconds to milliseconds and do both).
 *
 * The cursor is base64url JSON with a version tag: opaque to clients and
 * strictly increasing — a row updated after the page was read moves BEHIND
 * the cursor and is picked up by the next `updatedSince` sync, never lost.
 */
export const KEYSET_DEFAULT_LIMIT = 200;
export const KEYSET_MAX_LIMIT = 500;

export interface KeysetPosition {
    /** The stored `updatedAt`, as the database's fixed-width text. */
    readonly updatedAt: string;
    readonly id: string;
}

export interface KeysetQuery {
    readonly updatedSince?: Date | null;
    readonly cursor?: string | null;
    readonly limit?: number | null;
}

export interface KeysetPage<T> {
    readonly data: T[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
}

const VERSION = 1;
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export function encodeKeysetCursor(position: KeysetPosition): string {
    return Buffer.from(
        JSON.stringify({ v: VERSION, u: position.updatedAt, i: position.id }),
        'utf8',
    ).toString('base64url');
}

/** Throws {@link InvalidCursorError} for anything this API did not issue. */
export function decodeKeysetCursor(cursor: string): KeysetPosition {
    let parsed: { v?: unknown; u?: unknown; i?: unknown };
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
        throw new InvalidCursorError();
    }
    if (
        !parsed ||
        parsed.v !== VERSION ||
        typeof parsed.u !== 'string' ||
        !STAMP.test(parsed.u) ||
        typeof parsed.i !== 'string' ||
        parsed.i.length === 0 ||
        parsed.i.length > 64
    ) {
        throw new InvalidCursorError();
    }
    return { updatedAt: parsed.u, id: parsed.i };
}

/** 1–500; a missing or non-finite limit is the default. */
export function keysetLimit(limit: number | null | undefined): number {
    const requested =
        typeof limit === 'number' && Number.isFinite(limit)
            ? Math.trunc(limit)
            : KEYSET_DEFAULT_LIMIT;
    return Math.min(Math.max(requested, 1), KEYSET_MAX_LIMIT);
}

/** The dialect's fixed-width text of a timestamp column (sortable as text). */
function stampExpression(driver: string, column: string): string {
    if (driver === 'postgres') return `to_char(${column}, 'YYYY-MM-DD HH24:MI:SS.US')`;
    if (driver === 'mysql' || driver === 'mariadb') {
        return `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;
    }
    // better-sqlite3 / sqlite: text, written with and without milliseconds.
    return `strftime('%Y-%m-%d %H:%M:%f', ${column})`;
}

/**
 * Read one keyset page from `qb` (already filtered to what the caller may
 * see). `alias` is the query's main alias; the entity must have `updatedAt`
 * and `id`, and the query must not join (rows and raw rows stay aligned).
 * Reads `limit + 1` rows to know whether there is more.
 */
export async function readKeysetPage<T extends ObjectLiteral & { updatedAt: Date; id: string }>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    query: KeysetQuery,
): Promise<KeysetPage<T>> {
    const limit = keysetLimit(query.limit);
    const driver = String(qb.connection.options.type);
    const stamp = stampExpression(driver, `${alias}.updatedAt`);
    if (query.updatedSince) {
        qb.andWhere(`${alias}.updatedAt >= :keysetUpdatedSince`, {
            keysetUpdatedSince: query.updatedSince,
        });
    }
    if (query.cursor) {
        const after = decodeKeysetCursor(query.cursor);
        qb.andWhere(
            new Brackets((where) => {
                where
                    .where(`${stamp} > :keysetAfterStamp`, { keysetAfterStamp: after.updatedAt })
                    .orWhere(
                        new Brackets((tie) => {
                            tie.where(`${stamp} = :keysetAfterStamp`, {
                                keysetAfterStamp: after.updatedAt,
                            }).andWhere(`${alias}.id > :keysetAfterId`, {
                                keysetAfterId: after.id,
                            });
                        }),
                    );
            }),
        );
    }
    const { entities, raw } = await qb
        .addSelect(stamp, 'keyset_stamp')
        .orderBy(stamp, 'ASC')
        .addOrderBy(`${alias}.id`, 'ASC')
        .limit(limit + 1)
        .getRawAndEntities<{ keyset_stamp: string }>();
    const hasMore = entities.length > limit;
    const data = hasMore ? entities.slice(0, limit) : entities;
    const last = data.length - 1;
    return {
        data,
        nextCursor:
            hasMore && last >= 0
                ? encodeKeysetCursor({
                      updatedAt: String(raw[last].keyset_stamp),
                      id: data[last].id,
                  })
                : null,
        hasMore,
    };
}

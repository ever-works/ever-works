import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isAgentRunTimelineInsertionOrderTieBreak } from '@ever-works/contracts';
import { AgentRunLog } from '../../entities/agent-run-log.entity';
import { addInsertionOrderTieBreak, isSqliteFamilyDriver } from '../insertion-order';
import {
    keysetTieBreakSql,
    timeSortKeyColumnSql,
    timeSortKeyParameterSql,
    timeSortKeyStrategy,
} from '../time-sort-key';

/**
 * Where a timeline page resumes from.
 *
 * `tieBreak` is the exact value {@link AgentRunTimelinePage.tieBreaks}
 * handed out for the last row of the previous page, and is what makes the
 * page exact. `id` is the older, weaker form of the same thing: a cursor
 * minted before the tie-break column was driver-aware. At least one must
 * be set; `tieBreak` wins when both are.
 *
 * Neither is trusted to be a shape THIS store can compare: a cursor may
 * have been minted by a different driver (or by hand), and the read widens
 * a half it cannot use rather than binding it. See
 * {@link AgentRunLogRepository.findTimelinePage}.
 */
export interface AgentRunTimelineCursor {
    createdAt: Date;
    /** Legacy cursor position: the row's own id. */
    id?: string;
    /** Exact cursor position: see {@link AgentRunTimelinePage.tieBreaks}. */
    tieBreak?: string;
}

/** One keyset page of a run's timeline, with each row's cursor position. */
export interface AgentRunTimelinePage {
    /** Oldest first; at most `limit` rows. */
    rows: AgentRunLog[];
    /**
     * The cursor tie-break of each row, keyed by row id: the engine
     * `rowid` (insertion order) on the sqlite family, the row's own id
     * elsewhere. Round-tripping THIS — not the row id — is what keeps a
     * page exact, because it is the column the ORDER BY breaks ties on.
     */
    tieBreaks: Map<string, string>;
}

/** Raw alias the sqlite tie-break is selected under. */
const TIE_BREAK_ALIAS = 'timeline_tie_break';

/** A cursor half this driver can compare, with the name it binds under. */
interface ResolvedCursorPosition {
    /** Kept distinct so each branch's emitted SQL stays what it was. */
    parameter: 'afterTieBreak' | 'afterId';
    value: string | number;
}

/**
 * The half of `after` that names a position THIS driver's tie-break column
 * can be compared against, or `undefined` when the cursor carries none.
 *
 * The tie-break column is driver-shaped (see `keysetTieBreakSql`), so the
 * set of values it can hold is too:
 *
 * - on the sqlite family it is the engine `rowid`, an INTEGER, so the
 *   insertion-order form is the only half that is a position there — which
 *   is why an id-shaped cursor has always been widened instead;
 * - everywhere else it is the row's own uuid id, and the insertion-order
 *   form is not an id at all. Binding one anyway is not a wrong page but a
 *   FAILED query: Postgres resolves the untyped parameter against the
 *   `uuid` primary key and raises `invalid input syntax for type uuid`,
 *   which leaves the endpoint as an HTTP 500. That is the case this
 *   function exists to keep out of the query.
 *
 * `tieBreak` is preferred over `id` when both are usable; a half this
 * driver cannot use is skipped rather than rejected, and the caller then
 * honours the cursor as "the start of the millisecond it names" — the page
 * may REPEAT rows the caller already has (every consumer de-duplicates on
 * row id) but can never skip one.
 */
function resolveCursorPosition(
    sqlite: boolean,
    after: AgentRunTimelineCursor,
): ResolvedCursorPosition | undefined {
    const halves = [
        ['afterTieBreak', after.tieBreak],
        ['afterId', after.id],
    ] as const;
    for (const [parameter, half] of halves) {
        if (typeof half !== 'string' || half.length === 0) continue;
        const insertionOrder = isAgentRunTimelineInsertionOrderTieBreak(half);
        if (sqlite) {
            // rowid is an integer column; an id is text.
            if (insertionOrder) return { parameter, value: Number(half) };
        } else if (!insertionOrder) {
            return { parameter, value: half };
        }
    }
    return undefined;
}

@Injectable()
export class AgentRunLogRepository {
    constructor(
        @InjectRepository(AgentRunLog)
        private readonly repository: Repository<AgentRunLog>,
    ) {}

    async append(args: {
        runId: string;
        level: 'INFO' | 'WARN' | 'ERROR';
        step: string;
        message: string;
        metadata?: Record<string, unknown> | null;
    }): Promise<AgentRunLog> {
        const row = this.repository.create({
            runId: args.runId,
            level: args.level,
            step: args.step,
            message: args.message,
            metadata: args.metadata ?? null,
        });
        return this.repository.save(row);
    }

    async findByRun(runId: string, limit = 200, offset = 0): Promise<AgentRunLog[]> {
        return this.repository.find({
            where: { runId },
            order: { createdAt: 'ASC' },
            take: limit,
            skip: offset,
        });
    }

    /**
     * Session detail (Feature K) — count rows per step-name subset, one
     * query per subset. Powers the "N messages / N tool calls" chips.
     */
    async countByRunSteps(runId: string, steps: readonly string[]): Promise<number> {
        if (steps.length === 0) return 0;
        return this.repository
            .createQueryBuilder('log')
            .where('log.runId = :runId', { runId })
            .andWhere('log.step IN (:...steps)', { steps: [...steps] })
            .getCount();
    }

    /**
     * Session detail (Feature K) — one cursor page of the run's timeline
     * (message + tool-invocation rows), oldest first. Rows only; use
     * {@link findTimelinePage} when the caller has to mint a next cursor.
     */
    async findTimelineByRun(
        runId: string,
        steps: readonly string[],
        limit: number,
        after?: AgentRunTimelineCursor,
    ): Promise<AgentRunLog[]> {
        const { rows } = await this.findTimelinePage(runId, steps, limit, after);
        return rows;
    }

    /**
     * Session detail (Feature K) — one cursor page of the run's timeline
     * (message + tool-invocation rows), oldest first, with the cursor
     * position of every row.
     *
     * The keyset is `(sort key, tie-break)`, both driver-shaped:
     *
     * - The sort key is driver-shaped, chosen by `timeSortKeyStrategy`.
     *   On the sqlite family it is the canonical millisecond text of
     *   `createdAt` (`time-sort-key.ts`), compared against the same
     *   rendering of the cursor's bound `Date`: comparing the raw column
     *   against a bound `Date` there — which is what this read used to do
     *   — skips EVERY row that shares the cursor's second, because
     *   `@CreateDateColumn()` defaults to whole-second `datetime('now')`
     *   text while a `Date` binds as `'… 16:52:05.123'`. Everywhere else
     *   the key is the COLUMN ITSELF at whatever resolution it stores.
     *   Canonicalising it there would be a regression, not a fix: the
     *   Postgres column is a `timestamp` carrying microseconds and the
     *   tie-break below is a random uuid v4, so truncating the key to the
     *   millisecond a cursor names orders rows written inside one
     *   millisecond by uuid — an `assistant-message` row and the
     *   `tool-invocation` row it triggered a few hundred microseconds
     *   later come back in either order, and the transcript renders the
     *   tool call above the message that requested it.
     * - The cursor's instant half only ever names a millisecond
     *   (`<epochMillis>_<tieBreak>`), and `pg` truncates the microseconds
     *   away when it builds the row's `Date`, so on Postgres that half
     *   cannot say where the cursor row IS. Comparing the column against
     *   it is not a harmless widening: the cursor row itself satisfies
     *   `createdAt > :afterCreatedAt` again (`.123456 > .123`), so a full
     *   page whose rows all share the last row's millisecond — every page
     *   at `limit=1`, and a message plus its tool call at `limit=2` —
     *   comes back IDENTICAL, with the identical `nextCursor`, forever.
     *   De-duplicating on row id cannot rescue a pager whose cursor never
     *   moves. So on Postgres an id-shaped cursor is ANCHORED instead: the
     *   predicate reads the cursor row's own stored `createdAt` (a
     *   sub-select scoped to the run) and pages strictly after that exact
     *   `(createdAt, id)` position, which is the same order the ORDER BY
     *   walks. The cursor's millisecond is used only when that row cannot
     *   be found (deleted, or an id from another run), and then as "the
     *   start of the millisecond it names" — repeat, never skip, and the
     *   next cursor it hands back names a row that exists, so is anchored.
     *   The wire format is unchanged, so a cursor a browser already holds
     *   is still accepted and resumes right after the row it names.
     * - The tie-break is the engine `rowid` on the sqlite family, so rows
     *   appended inside one whole second come back in INSERTION order
     *   instead of random-uuid order, and the row's own id elsewhere. The
     *   cursor carries whichever one this driver orders by, so the
     *   predicate and the ORDER BY can never disagree and drop a row. The
     *   query is join-free and uses `limit`, as the raw `rowid` order key
     *   requires (see `insertion-order.ts`).
     *
     * A cursor minted before the tie-break was driver-aware carries a row
     * id where the sqlite family now wants a `rowid`. Rather than compare
     * the two — which could silently skip rows — such a cursor is honoured
     * as "the start of the millisecond it names": the page may REPEAT rows
     * the caller already has (both the API client and the live-follow poll
     * de-duplicate on row id) but can never skip one, and the next cursor
     * it hands back is exact. Off the sqlite family the id IS the
     * tie-break, so those cursors stay exact as they are.
     *
     * The MIRROR of that — a `rowid`-shaped cursor arriving at a driver
     * whose tie-break column is the row's uuid id — is widened the same
     * way, and must be: binding an integer against a `uuid` column is not
     * a wrong page but a failed query (`invalid input syntax for type
     * uuid` on Postgres), which surfaces as an HTTP 500 rather than as the
     * 400 a malformed cursor deserves. A cursor is therefore never taken
     * on trust to match this store; see `resolveCursorPosition`, and
     * `@ever-works/contracts`'s `run-timeline-cursor.ts` for the closed set
     * of shapes the edge admits.
     */
    async findTimelinePage(
        runId: string,
        steps: readonly string[],
        limit: number,
        after?: AgentRunTimelineCursor,
    ): Promise<AgentRunTimelinePage> {
        if (steps.length === 0) return { rows: [], tieBreaks: new Map() };
        const driverType = this.repository.manager?.connection?.options?.type;
        const sqlite = isSqliteFamilyDriver(driverType);
        const qb = this.repository
            .createQueryBuilder('log')
            .where('log.runId = :runId', { runId })
            .andWhere('log.step IN (:...steps)', { steps: [...steps] });

        // Three ways, never "Postgres or else" (see `timeSortKeyStrategy`):
        // ONLY the sqlite family may order this ascending keyset on a
        // millisecond-truncated key, because only there is the tie-break
        // (`rowid`) monotonic with insertion order. Postgres keeps its
        // microsecond `timestamp` column — truncating it would order rows
        // written inside one millisecond by random uuid — and every other
        // driver keeps the portable raw-column predicate unchanged.
        const strategy = timeSortKeyStrategy(driverType);
        const canonicalKey = strategy === 'canonical-text';
        const keySql = canonicalKey ? timeSortKeyColumnSql(driverType, 'log.createdAt') : null;
        const cursorKeySql = canonicalKey
            ? timeSortKeyParameterSql(driverType, 'afterCreatedAt')
            : null;
        const tieBreakSql = keysetTieBreakSql(qb, 'log.id');

        if (after) {
            // Never bind a half this driver's tie-break column cannot hold
            // — see `resolveCursorPosition`. With none, the cursor is
            // honoured as the start of the millisecond it names on EVERY
            // driver, which is the sqlite family's long-standing treatment
            // of an id-shaped cursor: repeat, never skip.
            const position = resolveCursorPosition(sqlite, after);
            if (!keySql || !cursorKeySql) {
                // A driver that orders on the column itself — Postgres,
                // where truncating would reorder inside a millisecond, and
                // any driver `time-sort-key.ts` does not canonicalise.
                if (position && strategy === 'native-column') {
                    // Postgres: anchor on the cursor row's STORED instant.
                    // The bound `:afterCreatedAt` is that instant cut to
                    // the millisecond, which the cursor row itself still
                    // exceeds — comparing against it re-serves the same
                    // full page with the same cursor forever. The anchor
                    // is found by primary key, so its id IS the bound
                    // position and `(createdAt, id) > (anchor, :position)`
                    // is exactly "after the cursor row" in the ORDER BY
                    // below. The sub-select is uncorrelated (evaluated
                    // once) and scoped to this run, so a row id from
                    // another run is "not found", never an anchor.
                    // `createdAt` is NOT NULL, so a NULL sub-select means
                    // exactly "no such row": only then is the cursor's
                    // millisecond used, widened to its start. Built
                    // through the query builder so the table and column
                    // identifiers come from entity metadata.
                    const anchorCreatedAtSql = qb
                        .subQuery()
                        .select('timelineAnchor.createdAt')
                        .from(this.repository.target, 'timelineAnchor')
                        .where(`timelineAnchor.id = :${position.parameter}`)
                        .andWhere('timelineAnchor.runId = :runId')
                        .getQuery();
                    qb.andWhere(
                        `(log.createdAt > ${anchorCreatedAtSql} OR (log.createdAt = ${anchorCreatedAtSql} AND log.id > :${position.parameter}) OR (${anchorCreatedAtSql} IS NULL AND log.createdAt >= :afterCreatedAt))`,
                        {
                            afterCreatedAt: after.createdAt,
                            [position.parameter]: position.value,
                        },
                    );
                } else if (position) {
                    // Every other non-canonical driver: the raw-column
                    // keyset, unchanged, at the column's own resolution.
                    qb.andWhere(
                        `(log.createdAt > :afterCreatedAt OR (log.createdAt = :afterCreatedAt AND log.id > :${position.parameter}))`,
                        {
                            afterCreatedAt: after.createdAt,
                            [position.parameter]: position.value,
                        },
                    );
                } else {
                    qb.andWhere('log.createdAt >= :afterCreatedAt', {
                        afterCreatedAt: after.createdAt,
                    });
                }
            } else if (position) {
                qb.andWhere(
                    `(${keySql} > ${cursorKeySql} OR (${keySql} = ${cursorKeySql} AND ${tieBreakSql} > :${position.parameter}))`,
                    {
                        afterCreatedAt: after.createdAt,
                        [position.parameter]: position.value,
                    },
                );
            } else {
                qb.andWhere(`${keySql} >= ${cursorKeySql}`, {
                    afterCreatedAt: after.createdAt,
                });
            }
        }

        qb.orderBy(keySql ?? 'log.createdAt', 'ASC');
        if (sqlite) {
            addInsertionOrderTieBreak(qb, 'ASC');
            qb.addSelect(tieBreakSql, TIE_BREAK_ALIAS);
        } else {
            qb.addOrderBy('log.id', 'ASC');
        }
        qb.limit(limit);

        const { entities, raw } = await qb.getRawAndEntities();
        const tieBreaks = new Map<string, string>();
        if (sqlite) {
            for (const record of raw as Array<Record<string, unknown>>) {
                const id = record.log_id;
                const tieBreak = record[TIE_BREAK_ALIAS];
                if (typeof id !== 'string') continue;
                if (typeof tieBreak === 'number' || typeof tieBreak === 'bigint') {
                    tieBreaks.set(id, String(tieBreak));
                } else if (typeof tieBreak === 'string' && tieBreak.length > 0) {
                    tieBreaks.set(id, tieBreak);
                }
            }
        }
        for (const row of entities) {
            if (!tieBreaks.has(row.id)) tieBreaks.set(row.id, row.id);
        }
        return { rows: entities, tieBreaks };
    }
}

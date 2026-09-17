import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRunLog } from '../../entities/agent-run-log.entity';
import { addInsertionOrderTieBreak, isSqliteFamilyDriver } from '../insertion-order';
import { keysetTieBreakSql, timeSortKeyColumnSql, timeSortKeyParameterSql } from '../time-sort-key';

/**
 * Where a timeline page resumes from.
 *
 * `tieBreak` is the exact value {@link AgentRunTimelinePage.tieBreaks}
 * handed out for the last row of the previous page, and is what makes the
 * page exact. `id` is the older, weaker form of the same thing: a cursor
 * minted before the tie-break column was driver-aware. At least one must
 * be set; `tieBreak` wins when both are.
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
     * - The sort key is the canonical millisecond text of `createdAt`
     *   (`time-sort-key.ts`), compared against the same rendering of the
     *   cursor's bound `Date`. Comparing the raw column against a bound
     *   `Date` instead — which is what this read used to do — skips EVERY
     *   row that shares the cursor's second on the sqlite family, where
     *   `@CreateDateColumn()` defaults to whole-second `datetime('now')`
     *   text, and re-serves the cursor row on Postgres, whose microseconds
     *   a millisecond cursor cannot name.
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

        const keySql = timeSortKeyColumnSql(driverType, 'log.createdAt');
        const cursorKeySql = timeSortKeyParameterSql(driverType, 'afterCreatedAt');
        const tieBreakSql = keysetTieBreakSql(qb, 'log.id');

        if (after) {
            if (!keySql || !cursorKeySql) {
                // A driver with no canonical key: the raw-column keyset,
                // unchanged.
                qb.andWhere(
                    '(log.createdAt > :afterCreatedAt OR (log.createdAt = :afterCreatedAt AND log.id > :afterId))',
                    { afterCreatedAt: after.createdAt, afterId: after.id ?? '' },
                );
            } else if (after.tieBreak !== undefined) {
                qb.andWhere(
                    `(${keySql} > ${cursorKeySql} OR (${keySql} = ${cursorKeySql} AND ${tieBreakSql} > :afterTieBreak))`,
                    {
                        afterCreatedAt: after.createdAt,
                        // rowid is an integer column; an id is text.
                        afterTieBreak: sqlite ? Number(after.tieBreak) : after.tieBreak,
                    },
                );
            } else if (!sqlite) {
                qb.andWhere(
                    `(${keySql} > ${cursorKeySql} OR (${keySql} = ${cursorKeySql} AND ${tieBreakSql} > :afterId))`,
                    { afterCreatedAt: after.createdAt, afterId: after.id ?? '' },
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

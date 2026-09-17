import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository, type FindOptionsWhere } from 'typeorm';
import {
    RAIL_REFUSAL_PAGE_SIZE,
    type ActionCategory,
    type RailRefusalSubjectType,
    type RailRefusalVerdict,
    type SafetyRailId,
    type SafetyReasonCode,
} from '@ever-works/contracts';
import { RailRefusal } from '../entities/rail-refusal.entity';

export interface RecordRailRefusalInput {
    userId: string;
    railId: SafetyRailId;
    category?: ActionCategory | null;
    verdict: RailRefusalVerdict;
    reasonCode: SafetyReasonCode;
    subjectType: RailRefusalSubjectType;
    subjectId?: string | null;
    agentId?: string | null;
    runId?: string | null;
    summary: string;
    requested?: Record<string, unknown> | null;
    ceiling?: Record<string, unknown> | null;
    proposalId?: string | null;
    collapseKey: string;
}

export interface ListRailRefusalsFilter {
    userId: string;
    railId?: SafetyRailId | null;
    category?: ActionCategory | null;
    agentId?: string | null;
    from?: Date | null;
    to?: Date | null;
    limit?: number;
    /** ISO timestamp of the last row on the previous page. */
    cursor?: string | null;
}

/**
 * Safety rails (AW-24) — the append-only refusal log.
 *
 * Owner-scoped on every read and write, like every other repository in this
 * area: a refusal names an agent, a run and a category, and an unscoped read
 * would let one workspace watch another's agents being stopped.
 *
 * Keyset pagination on `createdAt` rather than `OFFSET`: the log is read
 * newest-first over a ninety-day window that a single misconfigured agent can
 * fill, and an offset scan deep into that window is exactly the query that
 * gets slow on the day someone most needs to read it.
 */
@Injectable()
export class RailRefusalRepository {
    constructor(
        @InjectRepository(RailRefusal)
        private readonly refusals: Repository<RailRefusal>,
    ) {}

    async record(input: RecordRailRefusalInput): Promise<RailRefusal> {
        return this.refusals.save(
            this.refusals.create({
                userId: input.userId,
                railId: input.railId,
                category: input.category ?? null,
                verdict: input.verdict,
                reasonCode: input.reasonCode,
                subjectType: input.subjectType,
                subjectId: input.subjectId ?? null,
                agentId: input.agentId ?? null,
                runId: input.runId ?? null,
                summary: input.summary,
                requested: input.requested ?? null,
                ceiling: input.ceiling ?? null,
                proposalId: input.proposalId ?? null,
                collapseKey: input.collapseKey,
            }),
        );
    }

    /** One page, newest first. Asks for one extra row to report `hasMore`. */
    async list(filter: ListRailRefusalsFilter): Promise<{ rows: RailRefusal[]; hasMore: boolean }> {
        const limit = Math.min(Math.max(filter.limit ?? RAIL_REFUSAL_PAGE_SIZE, 1), 200);
        const rows = await this.refusals.find({
            where: this.buildWhere(filter),
            order: { createdAt: 'DESC', id: 'DESC' },
            take: limit + 1,
        });
        return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    }

    /** Every row in one collapsed group, so `Expand` can show what it hid. */
    async listByCollapseKey(
        userId: string,
        collapseKey: string,
        limit = RAIL_REFUSAL_PAGE_SIZE,
    ): Promise<RailRefusal[]> {
        return this.refusals.find({
            where: { userId, collapseKey },
            order: { createdAt: 'DESC', id: 'DESC' },
            take: Math.min(Math.max(limit, 1), 200),
        });
    }

    /** Every row in a window, for the counts and the collapse grouping. */
    async findInWindow(userId: string, from: Date, to: Date): Promise<RailRefusal[]> {
        return this.refusals.find({
            where: { userId, createdAt: Between(from, to) },
            order: { createdAt: 'DESC', id: 'DESC' },
        });
    }

    /** Delete rows older than a cut-off, in bounded batches. */
    async pruneOlderThan(cutoff: Date, batchSize = 5_000): Promise<number> {
        const doomed = await this.refusals.find({
            where: { createdAt: LessThan(cutoff) },
            select: { id: true },
            take: Math.min(Math.max(batchSize, 1), 20_000),
        });
        if (doomed.length === 0) return 0;
        await this.refusals.delete(doomed.map((row) => row.id));
        return doomed.length;
    }

    private buildWhere(filter: ListRailRefusalsFilter): FindOptionsWhere<RailRefusal> {
        const where: FindOptionsWhere<RailRefusal> = { userId: filter.userId };
        if (filter.railId) where.railId = filter.railId;
        if (filter.category) where.category = filter.category;
        if (filter.agentId) where.agentId = filter.agentId;

        const cursorAt = filter.cursor ? new Date(filter.cursor) : null;
        const upper =
            cursorAt && !Number.isNaN(cursorAt.getTime())
                ? filter.to && filter.to < cursorAt
                    ? filter.to
                    : cursorAt
                : (filter.to ?? null);
        if (filter.from && upper) where.createdAt = Between(filter.from, upper);
        else if (upper) where.createdAt = LessThan(upper);
        else if (filter.from) where.createdAt = Between(filter.from, new Date(8_640_000_000_000));
        return where;
    }
}

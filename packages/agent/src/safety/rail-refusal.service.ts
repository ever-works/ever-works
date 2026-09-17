import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
    RAIL_REFUSAL_COLLAPSE_THRESHOLD,
    RAIL_REFUSAL_PAGE_SIZE,
    RAIL_REFUSAL_SUMMARY_MAX,
    type ActionCategory,
    type RailRefusalCountsDto,
    type RailRefusalDto,
    type RailRefusalGroupDto,
    type RailRefusalListDto,
    type SafetyRailId,
} from '@ever-works/contracts';
import type { RailRefusal } from '../entities/rail-refusal.entity';
import {
    RailRefusalRepository,
    type ListRailRefusalsFilter,
    type RecordRailRefusalInput,
} from './rail-refusal.repository';

/** What `record()` needs, minus the collapse key it computes itself. */
export type RecordRefusalInput = Omit<RecordRailRefusalInput, 'collapseKey'>;

/**
 * Safety rails (AW-24) — writing and reading what the rails stopped.
 *
 * ## `record()` NEVER throws
 *
 * FR-69: writing a refusal must never fail the action path. A refusal that
 * cannot be written still refuses, and is counted here as an UNRECORDED
 * refusal so the number is visible rather than silently zero. This is the
 * same posture `FleetKillSwitchService` takes with its audit row: bookkeeping
 * must never be the reason a stop did not land.
 *
 * ## The collapse key
 *
 * `sha1(railId:agentId:category:yyyy-mm-dd)` in UTC, computed at write time.
 * A misconfigured agent can trip one rail hundreds of times a day, and the
 * log that is the evidence must not be the thing it buries. Computing it here
 * rather than deriving it on read makes the collapse one indexed group-by
 * instead of a scan across a ninety-day retention window.
 */
@Injectable()
export class RailRefusalService {
    private readonly logger = new Logger(RailRefusalService.name);

    /** Refusals this process could not persist (FR-69). Exposed on the counts. */
    private unrecorded = 0;

    constructor(private readonly repository: RailRefusalRepository) {}

    /**
     * Append one refusal or hold. Best-effort BY CONTRACT — every failure is
     * swallowed and counted.
     */
    async record(input: RecordRefusalInput): Promise<void> {
        try {
            await this.repository.record({
                ...input,
                summary: capSummary(input.summary),
                collapseKey: collapseKeyFor(
                    input.railId,
                    input.agentId,
                    input.category,
                    new Date(),
                ),
            });
        } catch (error) {
            this.unrecorded += 1;
            this.logger.error(
                `Rail refusal could not be recorded (${input.railId}/${input.reasonCode}) — the ` +
                    `action was still refused: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
        }
    }

    /** How many refusals this process failed to persist. */
    unrecordedCount(): number {
        return this.unrecorded;
    }

    /**
     * One page of the log, newest first, with the day-groups that exceeded
     * the collapse threshold lifted out of it.
     *
     * The groups are computed over the WINDOW rather than over the page: a
     * group of nine hundred that happens to start on page three is still a
     * group, and paging through it one row at a time is exactly what FR-68
     * exists to prevent.
     */
    async list(filter: ListRailRefusalsFilter): Promise<RailRefusalListDto> {
        const limit = filter.limit ?? RAIL_REFUSAL_PAGE_SIZE;
        const from = filter.from ?? null;
        const to = filter.to ?? new Date();

        const window = from
            ? await this.repository.findInWindow(filter.userId, from, to)
            : (await this.repository.list({ ...filter, limit: 500 })).rows;

        const grouped = groupByCollapseKey(window);
        const collapsedKeys = new Set(
            grouped
                .filter((group) => group.count > RAIL_REFUSAL_COLLAPSE_THRESHOLD)
                .map((group) => group.collapseKey),
        );

        const page = await this.repository.list({ ...filter, limit });
        const items = page.rows
            .filter((row) => !collapsedKeys.has(row.collapseKey))
            .map(toRefusalDto);
        const last = page.rows[page.rows.length - 1];

        return {
            items,
            groups: grouped.filter((group) => collapsedKeys.has(group.collapseKey)),
            nextCursor: page.hasMore && last ? new Date(last.createdAt).toISOString() : null,
            total: window.length,
        };
    }

    /** The rows behind one collapsed group. */
    async expand(userId: string, collapseKey: string, limit?: number): Promise<RailRefusalDto[]> {
        const rows = await this.repository.listByCollapseKey(userId, collapseKey, limit);
        return rows.map(toRefusalDto);
    }

    /** The header counts on the Safety screen. */
    async counts(userId: string, windowDays: number): Promise<RailRefusalCountsDto> {
        const to = new Date();
        const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
        const rows = await this.repository.findInWindow(userId, from, to);
        return {
            windowDays,
            total: rows.length,
            refused: rows.filter((row) => row.verdict === 'refused').length,
            held: rows.filter((row) => row.verdict === 'held').length,
            widenAttempts: rows.filter((row) => row.reasonCode === 'instruction-widening-attempt')
                .length,
            unrecorded: this.unrecorded,
        };
    }

    /** Delete rows past the retention horizon. Returns how many went. */
    async prune(retentionDays: number, batchSize?: number): Promise<number> {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        return this.repository.pruneOlderThan(cutoff, batchSize);
    }
}

/** `sha1(railId:agentId:category:yyyy-mm-dd)`, UTC. */
export function collapseKeyFor(
    railId: SafetyRailId,
    agentId: string | null | undefined,
    category: ActionCategory | null | undefined,
    at: Date,
): string {
    const day = at.toISOString().slice(0, 10);
    return createHash('sha1')
        .update(`${railId}:${agentId ?? '-'}:${category ?? '-'}:${day}`, 'utf8')
        .digest('hex');
}

function capSummary(summary: string): string {
    const trimmed = (summary ?? '').trim();
    return trimmed.length > RAIL_REFUSAL_SUMMARY_MAX
        ? `${trimmed.slice(0, RAIL_REFUSAL_SUMMARY_MAX - 1)}…`
        : trimmed;
}

function groupByCollapseKey(rows: readonly RailRefusal[]): RailRefusalGroupDto[] {
    const groups = new Map<string, RailRefusalGroupDto>();
    for (const row of rows) {
        const at = new Date(row.createdAt).toISOString();
        const existing = groups.get(row.collapseKey);
        if (!existing) {
            groups.set(row.collapseKey, {
                collapseKey: row.collapseKey,
                railId: row.railId,
                category: row.category ?? null,
                agentId: row.agentId ?? null,
                day: at.slice(0, 10),
                count: 1,
                firstAt: at,
                lastAt: at,
                summary: row.summary,
            });
            continue;
        }
        existing.count += 1;
        if (at < existing.firstAt) existing.firstAt = at;
        if (at > existing.lastAt) {
            existing.lastAt = at;
            existing.summary = row.summary;
        }
    }
    return [...groups.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

function toRefusalDto(row: RailRefusal): RailRefusalDto {
    return {
        id: row.id,
        railId: row.railId,
        category: row.category ?? null,
        verdict: row.verdict,
        reasonCode: row.reasonCode,
        subjectType: row.subjectType,
        subjectId: row.subjectId ?? null,
        agentId: row.agentId ?? null,
        runId: row.runId ?? null,
        summary: row.summary,
        requested: row.requested ?? null,
        ceiling: row.ceiling ?? null,
        proposalId: row.proposalId ?? null,
        createdAt: new Date(row.createdAt).toISOString(),
    };
}

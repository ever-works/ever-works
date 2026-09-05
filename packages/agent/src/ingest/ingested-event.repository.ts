import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IngestedEvent } from '../entities/ingested-event.entity';

/**
 * Dedupe identity for an ingested event: sha256 over
 * `(userId, source, sourceEventId)`.
 *
 * The envelope identity is `(source, sourceEventId)` — it is scoped per
 * OWNER here so two users connected to the same external workspace each
 * keep their own row (a global key would silently drop the second
 * user's delivery and leak the first user's row back to them).
 * Segments are length-prefixed so `('ab','c')` and `('a','bc')` can
 * never collide.
 */
export function computeDedupeKey(userId: string, source: string, sourceEventId: string): string {
    const hash = createHash('sha256');
    for (const segment of [userId, source, sourceEventId]) {
        hash.update(`${segment.length}:${segment}|`);
    }
    return hash.digest('hex');
}

/**
 * How many distinct owners one drain batch is shared between.
 *
 * Bounds the per-tick query count (one grouped scan plus at most this
 * many small reads). Owners beyond the cap are not dropped — they rank
 * by their oldest waiting row, so they enter on a later tick as the
 * drained owners' minimums advance past theirs.
 */
export const MAX_DRAIN_OWNERS = 25;

export interface CreateIngestedEventData {
    userId: string;
    organizationId?: string | null;
    workId?: string | null;
    source: string;
    sourceEventId: string;
    kind: string;
    occurredAt: Date;
    actorName?: string | null;
    subjectType?: string | null;
    subjectExternalId?: string | null;
    title?: string | null;
    sourceUrl?: string | null;
    payload: Record<string, unknown>;
}

/** Filters for the owner-scoped recent-events page (chat tool + Work feed). */
export interface ListRecentEventsFilter {
    /** Narrow to one Work — the per-Work Activities feed. */
    workId?: string;
    /** Narrow to one producing plugin id. */
    source?: string;
    /** Page size; clamped to 1..200. */
    limit?: number;
}

/**
 * Feature-owned repository (provided by `EventIngestModule`, not
 * `DatabaseModule` — same split as `WorkProposalRepository`).
 */
@Injectable()
export class IngestedEventRepository {
    constructor(
        @InjectRepository(IngestedEvent)
        private readonly repository: Repository<IngestedEvent>,
    ) {}

    /**
     * Insert the event unless a row with the same dedupe identity
     * already exists. Check-then-insert is not atomic, so the UNIQUE
     * index race is treated as the idempotent outcome it should be
     * (same convention as `ActivityLogService.ingestFromWebsite`).
     */
    async createIfNew(
        data: CreateIngestedEventData,
    ): Promise<{ event: IngestedEvent; created: boolean }> {
        const dedupeKey = computeDedupeKey(data.userId, data.source, data.sourceEventId);

        const existing = await this.repository.findOne({ where: { dedupeKey } });
        if (existing) {
            return { event: existing, created: false };
        }

        try {
            const event = await this.repository.save(
                this.repository.create({ ...data, dedupeKey }),
            );
            return { event, created: true };
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                const winner = await this.repository.findOne({ where: { dedupeKey } });
                if (winner) {
                    return { event: winner, created: false };
                }
            }
            throw error;
        }
    }

    /**
     * Oldest-first batch of rows the processor has not drained yet,
     * SHARED FAIRLY between the owners that have work waiting.
     *
     * A plain `WHERE processedAt IS NULL ORDER BY occurredAt ASC LIMIT n`
     * is a global FIFO with no tenant partitioning, and the drain that
     * consumes it runs every five minutes with a batch of 50. One chatty
     * source — a Sentry issue flapping, a connector backfill — therefore
     * puts thousands of rows in front of every other customer on the
     * deployment, and a newly filed GitHub issue does not become a Task
     * for hours. That is the "input that silently swallows genuinely new
     * work" this repository must not have.
     *
     * So the batch is assembled per owner instead: the owners with
     * unprocessed rows are ranked by their OLDEST waiting row (so nobody
     * can be starved indefinitely — a neglected owner's oldest row keeps
     * ageing until it ranks), each of the first {@link MAX_DRAIN_OWNERS}
     * contributes an equal share, and the merged batch is still handed
     * back oldest-first so per-issue ordering inside one owner is
     * unchanged.
     *
     * The single-owner case (every non-hosted deployment, and every
     * hosted one at low volume) short-circuits to exactly the query it
     * always ran.
     */
    async findUnprocessed(limit: number): Promise<IngestedEvent[]> {
        const capped = Math.max(1, Math.trunc(limit));
        const oldestFirst = { occurredAt: 'ASC', createdAt: 'ASC' } as const;

        const owners = await this.findOwnersWithUnprocessed(
            Math.min(capped, MAX_DRAIN_OWNERS),
        ).catch(() => null);

        // No owner scan (unsupported driver shape / transient failure) or
        // a single owner: the fair batch and the plain batch are the same
        // rows, so take the cheaper path.
        if (!owners || owners.length <= 1) {
            return this.repository.find({
                where: { processedAt: IsNull() },
                order: oldestFirst,
                take: capped,
            });
        }

        const share = Math.max(1, Math.ceil(capped / owners.length));
        const batch: IngestedEvent[] = [];
        for (const userId of owners) {
            const rows = await this.repository.find({
                where: { processedAt: IsNull(), userId },
                order: oldestFirst,
                take: share,
            });
            batch.push(...rows);
        }

        return batch
            .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
            .slice(0, capped);
    }

    /**
     * Owner ids that have unprocessed rows, the one whose oldest row has
     * waited longest first. Ranking by `MIN(occurredAt)` — rather than by
     * row count or arbitrarily — is what makes the share-out
     * starvation-free: draining an owner advances their minimum, so every
     * other owner's minimum becomes comparatively older and they rank in
     * on a later tick.
     */
    private async findOwnersWithUnprocessed(limit: number): Promise<string[]> {
        const rows = await this.repository
            .createQueryBuilder('event')
            .select('event.userId', 'userId')
            .where('event.processedAt IS NULL')
            .groupBy('event.userId')
            .orderBy('MIN(event.occurredAt)', 'ASC')
            .limit(limit)
            .getRawMany<{ userId: string }>();
        return rows.map((row) => row.userId).filter((userId): userId is string => Boolean(userId));
    }

    async markProcessed(id: string, processedAt: Date = new Date()): Promise<void> {
        await this.repository.update(id, { processedAt });
    }

    /**
     * Owner-scoped recent events (chat tool + Work feed surfaces).
     *
     * `filter.workId` narrows to a single Work — the per-Work Activities
     * feed. It is applied ON TOP of the owner scope, never instead of
     * it, so passing another tenant's Work id yields an empty page
     * rather than their events. `filter.source` narrows to one connector.
     */
    async findRecentByUser(
        userId: string,
        limitOrFilter: number | ListRecentEventsFilter = 20,
    ): Promise<IngestedEvent[]> {
        const filter: ListRecentEventsFilter =
            typeof limitOrFilter === 'number' ? { limit: limitOrFilter } : limitOrFilter;
        const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
        const qb = this.repository
            .createQueryBuilder('event')
            .where('event.userId = :userId', { userId });
        if (filter.workId) {
            qb.andWhere('event.workId = :workId', { workId: filter.workId });
        }
        if (filter.source) {
            qb.andWhere('event.source = :source', { source: filter.source });
        }
        return qb.orderBy('event.occurredAt', 'DESC').take(limit).getMany();
    }

    /**
     * Per-Work feed page — owner-scoped by construction. Thin alias so
     * feed callers read as what they are and can never forget the owner
     * argument.
     */
    async findRecentByWork(userId: string, workId: string, limit = 20): Promise<IngestedEvent[]> {
        return this.findRecentByUser(userId, { workId, limit });
    }

    /**
     * Org-scoped digest briefings — the most recent ingested events of
     * one Organization, across every member who connected a source.
     *
     * Separate from `findRecentByUser` on purpose: that read is
     * owner-keyed and its callers (chat tool, Work feed) rely on it.
     * Rows with no `organizationId` stamped are personal and never
     * matched here, so turning on an org digest cannot surface a
     * member's unscoped events.
     */
    async findRecentByOrganization(organizationId: string, limit = 200): Promise<IngestedEvent[]> {
        const take = Math.min(Math.max(limit, 1), 500);
        return this.repository
            .createQueryBuilder('event')
            .where('event.organizationId = :organizationId', { organizationId })
            .orderBy('event.occurredAt', 'DESC')
            .take(take)
            .getMany();
    }

    async findById(id: string): Promise<IngestedEvent | null> {
        return this.repository.findOne({ where: { id } });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        // Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite SQLITE_CONSTRAINT —
        // same convention as ActivityLogService.isUniqueViolation.
        const codes = ['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT'];
        return codes.includes(driverCode as string) || codes.includes(topCode as string);
    }
}

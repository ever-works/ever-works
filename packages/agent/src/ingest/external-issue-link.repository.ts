import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalIssueLink } from '../entities/external-issue-link.entity';

/** Everything needed to bind one external issue to one Task. */
export interface UpsertExternalIssueLinkData {
    userId: string;
    taskId: string;
    source: string;
    externalIssueId: string;
    externalKey?: string | null;
    title?: string | null;
    url?: string | null;
    lastIngestedEventId?: string | null;
    lastSeenAt?: Date | null;
    tenantId?: string | null;
    organizationId?: string | null;
    /**
     * Times this issue has re-opened work after its Task was closed.
     * Omitted = left untouched (the ordinary file / refresh path never
     * moves it); the triage filer sets it explicitly when a regression
     * supersedes a closed Task.
     */
    regressionCount?: number;
    /**
     * Insert-only: when a row already binds this
     * `(userId, source, externalIssueId)`, leave it exactly as it is and
     * hand it back instead of re-pointing it at `taskId`.
     *
     * This is what makes a FIRST link race-safe. Two concurrent drains
     * that both miss the link both create a Task and both write; without
     * this flag the second write re-points the single row at the second
     * Task and ORPHANS the first — no link row references it, so it never
     * receives an update comment and is never deduped away, and the board
     * shows two triage Tasks for one issue. With it the loser learns it
     * lost (the returned row names the winner's Task) and can clean up.
     *
     * A deliberate RE-POINT — a regression superseding a closed Task, or
     * re-filing after the linked Task was deleted — omits the flag.
     */
    onlyIfAbsent?: boolean;
}

/** Freshness breadcrumbs stamped by the ingest drain. */
export interface TouchExternalIssueLinkData {
    lastIngestedEventId?: string | null;
    lastSeenAt?: Date | null;
    title?: string | null;
    url?: string | null;
}

/**
 * Feature-owned repository for the external-issue ↔ Task mapping
 * (`ExternalIssueLink`). Provided by `EventIngestModule` — same split as
 * `IngestedEventRepository` / `IngestCursorRepository` /
 * `IngestInstallBindingRepository`.
 *
 * Every read is owner-scoped by construction: `userId` is part of the
 * unique identity and of every lookup signature, so one customer can
 * never resolve another customer's Task from a shared external issue id.
 */
@Injectable()
export class ExternalIssueLinkRepository {
    private readonly logger = new Logger(ExternalIssueLinkRepository.name);

    constructor(
        @InjectRepository(ExternalIssueLink)
        private readonly repository: Repository<ExternalIssueLink>,
    ) {}

    /** The link for one external issue under one owner, or null. */
    async findByExternal(
        userId: string,
        source: string,
        externalIssueId: string,
    ): Promise<ExternalIssueLink | null> {
        if (!userId || !source || !externalIssueId) return null;
        return this.repository.findOne({ where: { userId, source, externalIssueId } });
    }

    /** Every external issue linked to one Task (a Task may mirror several). */
    async findByTask(taskId: string): Promise<ExternalIssueLink[]> {
        if (!taskId) return [];
        return this.repository.find({ where: { taskId }, order: { createdAt: 'ASC' } });
    }

    /** Every link owned by one user (settings UI / diagnostics). */
    async findByUser(userId: string): Promise<ExternalIssueLink[]> {
        if (!userId) return [];
        return this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    }

    /**
     * Bind (or re-point) an external issue to a Task — idempotent on
     * `(userId, source, externalIssueId)`.
     *
     * SECURITY: callers MUST have verified that `taskId` belongs to
     * `userId` before calling. Like `TaskRelation`, the schema carries no
     * FK that enforces ownership across the join (EW-654 cycle
     * avoidance), so the check lives in the service layer
     * (`ExternalIssueLinkService.link`) and any new insert path has to
     * re-implement it.
     */
    async upsert(data: UpsertExternalIssueLinkData): Promise<ExternalIssueLink> {
        const existing = await this.findByExternal(data.userId, data.source, data.externalIssueId);
        if (existing) {
            // Insert-only caller and the key is taken: the holder wins,
            // untouched. See `onlyIfAbsent`.
            if (data.onlyIfAbsent) return existing;
            existing.taskId = data.taskId;
            if (data.externalKey !== undefined) existing.externalKey = data.externalKey;
            if (data.title !== undefined) existing.title = data.title;
            if (data.url !== undefined) existing.url = data.url;
            if (data.lastIngestedEventId !== undefined) {
                existing.lastIngestedEventId = data.lastIngestedEventId;
            }
            if (data.lastSeenAt !== undefined) existing.lastSeenAt = data.lastSeenAt;
            if (data.tenantId !== undefined) existing.tenantId = data.tenantId;
            if (data.organizationId !== undefined) existing.organizationId = data.organizationId;
            if (data.regressionCount !== undefined) {
                existing.regressionCount = data.regressionCount;
            }
            return this.repository.save(existing);
        }

        // `onlyIfAbsent` is a write MODE, not a column — keep it out of
        // the entity the insert is built from.
        const { onlyIfAbsent: _mode, ...columns } = data;
        try {
            return await this.repository.save(
                this.repository.create({ ...columns, regressionCount: data.regressionCount ?? 0 }),
            );
        } catch (error) {
            // Concurrent first link for the same issue — the UNIQUE index
            // picked a winner; adopt it rather than throw.
            const winner = await this.findByExternal(
                data.userId,
                data.source,
                data.externalIssueId,
            );
            if (winner) return winner;
            this.logger.warn(
                `Failed to link ${data.source} issue "${data.externalIssueId}" to task ${data.taskId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            throw error;
        }
    }

    /**
     * Refresh the freshness breadcrumbs on an EXISTING link. Never
     * creates one — a Task association is a deliberate decision, not
     * something ingest infers.
     */
    async touch(
        userId: string,
        source: string,
        externalIssueId: string,
        data: TouchExternalIssueLinkData,
    ): Promise<ExternalIssueLink | null> {
        const existing = await this.findByExternal(userId, source, externalIssueId);
        if (!existing) return null;
        if (data.lastIngestedEventId !== undefined) {
            existing.lastIngestedEventId = data.lastIngestedEventId;
        }
        if (data.lastSeenAt !== undefined) existing.lastSeenAt = data.lastSeenAt;
        if (data.title) existing.title = data.title;
        if (data.url) existing.url = data.url;
        return this.repository.save(existing);
    }

    /** Remove one link (unbind), owner-scoped. Returns true when a row went. */
    async unlink(userId: string, source: string, externalIssueId: string): Promise<boolean> {
        const existing = await this.findByExternal(userId, source, externalIssueId);
        if (!existing) return false;
        await this.repository.remove(existing);
        return true;
    }
}

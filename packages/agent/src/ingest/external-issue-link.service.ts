import { Injectable, Logger, Optional } from '@nestjs/common';
import type { IngestedEvent } from '../entities/ingested-event.entity';
import type { ExternalIssueLink } from '../entities/external-issue-link.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { ExternalIssueLinkRepository } from './external-issue-link.repository';

/** Thrown when the caller does not own the Task they are linking to. */
export class ExternalIssueLinkOwnershipError extends Error {
    constructor(taskId: string) {
        super(`Task ${taskId} is not owned by the linking user`);
        // Matched BY NAME across packages (same convention as
        // `EventSourceNotConfiguredError`) so the API layer can map it to
        // a 404/403 without importing the class.
        this.name = 'ExternalIssueLinkOwnershipError';
    }
}

/** Input for an explicit "this issue IS that Task" binding. */
export interface LinkExternalIssueInput {
    userId: string;
    taskId: string;
    /** Producing plugin id / receiver namespace (`linear-connector`, `github`). */
    source: string;
    /** The issue's stable id in the source system. */
    externalIssueId: string;
    externalKey?: string | null;
    title?: string | null;
    url?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
    /**
     * Freshness breadcrumbs a server-side filer stamps in the SAME write
     * that binds the issue (the triage intake files a Task and links it
     * in one step, then uses `lastIngestedEventId` as its idempotency
     * marker when the drain retries the row). Omitted = left untouched.
     */
    lastIngestedEventId?: string | null;
    lastSeenAt?: Date | null;
}

/**
 * The `subject.type` values a connector uses for issue-shaped subjects,
 * plus the `kind` suffix fallback. An event qualifies as an external
 * issue when EITHER matches — connectors are free-form on `kind`, so
 * relying on only one signal would miss half of them.
 */
export const EXTERNAL_ISSUE_SUBJECT_TYPES: readonly string[] = ['issue', 'ticket', 'story', 'bug'];
export const EXTERNAL_ISSUE_KIND_FRAGMENTS: readonly string[] = ['issue', 'ticket'];

/**
 * External-issue ↔ Task mapping (audit item (i)).
 *
 * Two jobs:
 *
 *  1. **Binding** — `link()` records "external issue X in source S IS
 *     platform Task T", after verifying the caller owns T. This is the
 *     join that did not exist: tracker connectors ingested `*.issue`
 *     events and the platform had Tasks, with nothing connecting them.
 *
 *  2. **Freshness** — `recordEvent()` is called from the ingest drain
 *     for every processed row. When the row is an issue event that is
 *     ALREADY linked, it stamps the link with the event id / timestamp /
 *     latest title + url. It NEVER creates a link: inferring a Task
 *     association from an ingested event would manufacture Tasks nobody
 *     asked for, so the binding stays a deliberate act.
 *
 * Ownership is enforced here, not in the schema: like `TaskRelation`,
 * the entity carries no cross-entity FK (EW-654 cycle avoidance), so any
 * future insert path must re-run the `findByIdAndUser` check.
 */
@Injectable()
export class ExternalIssueLinkService {
    private readonly logger = new Logger(ExternalIssueLinkService.name);

    constructor(
        private readonly links: ExternalIssueLinkRepository,
        // @Optional() so lean bootstraps (and the trigger worker's remote
        // proxy graph) can construct the service without the Tasks
        // feature wired. Without it, ownership cannot be proven, so
        // `link()` refuses rather than trusting the caller.
        @Optional() private readonly tasks?: TaskRepository,
    ) {}

    /**
     * Bind an external issue to a Task. Idempotent: re-linking the same
     * issue re-points it (and refreshes the labels) instead of
     * duplicating.
     */
    async link(input: LinkExternalIssueInput): Promise<ExternalIssueLink> {
        if (!this.tasks) {
            throw new ExternalIssueLinkOwnershipError(input.taskId);
        }
        const task = await this.tasks.findByIdAndUser(input.taskId, input.userId);
        if (!task) {
            // Same 404-shaped answer whether the Task is missing or owned
            // by somebody else — never leak existence.
            throw new ExternalIssueLinkOwnershipError(input.taskId);
        }

        return this.links.upsert({
            userId: input.userId,
            taskId: input.taskId,
            source: input.source,
            externalIssueId: input.externalIssueId,
            externalKey: input.externalKey ?? null,
            title: input.title ?? null,
            url: input.url ?? null,
            tenantId: input.tenantId ?? null,
            organizationId: input.organizationId ?? null,
            ...(input.lastIngestedEventId !== undefined
                ? { lastIngestedEventId: input.lastIngestedEventId }
                : {}),
            ...(input.lastSeenAt !== undefined ? { lastSeenAt: input.lastSeenAt } : {}),
        });
    }

    /** The full link row for an owner-scoped external issue, or null. */
    async find(
        userId: string,
        source: string,
        externalIssueId: string,
    ): Promise<ExternalIssueLink | null> {
        return this.links.findByExternal(userId, source, externalIssueId);
    }

    /** Remove a binding, owner-scoped. True when a row went. */
    async unlink(userId: string, source: string, externalIssueId: string): Promise<boolean> {
        return this.links.unlink(userId, source, externalIssueId);
    }

    /** The Task an external issue maps to for this owner, or null. */
    async resolveTaskId(
        userId: string,
        source: string,
        externalIssueId: string,
    ): Promise<string | null> {
        const link = await this.links.findByExternal(userId, source, externalIssueId);
        return link?.taskId ?? null;
    }

    /** Every external issue linked to one Task. */
    async listForTask(taskId: string): Promise<ExternalIssueLink[]> {
        return this.links.findByTask(taskId);
    }

    /**
     * Ingest-drain hook: refresh an EXISTING link from a just-processed
     * event. Returns the touched link, or null when the event is not an
     * issue event or the issue is not linked to anything.
     *
     * Only ISSUE-level events refresh the stored `title`/`url`. Comment
     * events carry the parent issue as their subject (that is how they
     * reach this method at all), but their `sourceUrl` is the comment
     * permalink — writing it onto the link would quietly replace the
     * canonical issue link with a deep link to one reply.
     */
    async recordEvent(event: IngestedEvent): Promise<ExternalIssueLink | null> {
        const externalIssueId = externalIssueIdOf(event);
        if (!externalIssueId) return null;

        return this.links.touch(event.userId, event.source, externalIssueId, {
            lastIngestedEventId: event.id,
            lastSeenAt: event.occurredAt,
            ...(isIssueKind(event.kind)
                ? { title: event.title ?? null, url: event.sourceUrl ?? null }
                : {}),
        });
    }

    /** Best-effort wrapper for the drain — never throws. */
    async tryRecordEvent(event: IngestedEvent): Promise<boolean> {
        try {
            return (await this.recordEvent(event)) !== null;
        } catch (error) {
            this.logger.warn(
                `External-issue link refresh skipped for ingested event ${event.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }
}

/**
 * The external issue id an event refers to, or undefined when the event
 * is not issue-shaped. Reads `subject.externalId` — the only field a
 * connector guarantees is the SOURCE's own stable id (`sourceEventId`
 * carries a revision suffix such as `${issueId}:${updatedAt}` and is
 * therefore useless as a join key).
 */
export function externalIssueIdOf(event: IngestedEvent): string | undefined {
    const externalId = event.subjectExternalId;
    if (!externalId) return undefined;

    const subjectType = (event.subjectType ?? '').toLowerCase();
    if (EXTERNAL_ISSUE_SUBJECT_TYPES.includes(subjectType)) return externalId;
    if (isIssueKind(event.kind)) return externalId;
    return undefined;
}

/** True when the event's own kind names an issue (not a comment on one). */
export function isIssueKind(kind: string | null | undefined): boolean {
    const lowered = (kind ?? '').toLowerCase();
    return EXTERNAL_ISSUE_KIND_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

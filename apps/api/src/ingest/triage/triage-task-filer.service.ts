import { BadRequestException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
    EventIngestService,
    ExternalIssueLinkService,
    type ExternalIssueLink,
    type IngestedEvent,
} from '@ever-works/agent/ingest';
import { WorkRepository } from '@ever-works/agent/database';
import {
    TaskChatService,
    TaskPriority,
    TaskRepository,
    TasksService,
    type Task,
} from '@ever-works/agent/tasks-domain';
import { redactSecrets } from '@ever-works/agent/utils';
import {
    TRIAGE_EVENT_KINDS,
    TRIAGE_LABEL,
    renderTriageBody,
    renderTriageTitle,
    renderTriageUpdate,
    triageExternalKeyOf,
    triageFactsOf,
    triagePriorityOf,
    type TriagePriority,
} from './triage-task-body';

const PRIORITY: Record<TriagePriority, TaskPriority> = {
    p1: TaskPriority.P1,
    p2: TaskPriority.P2,
    p3: TaskPriority.P3,
    p4: TaskPriority.P4,
};

/** What the filer did with one drained event. */
export type TriageOutcome =
    | { readonly outcome: 'filed'; readonly taskId: string }
    | { readonly outcome: 'updated'; readonly taskId: string; readonly commented: boolean }
    | { readonly outcome: 'noop'; readonly taskId: string }
    | {
          readonly outcome: 'skipped';
          readonly reason: 'no-external-id' | 'no-work' | 'work-unavailable' | 'rejected';
      };

/**
 * Deduped triage Task filer (self-build program note §6, R2/R23).
 *
 * The founder's intake path is "file an issue, the fleet picks it up".
 * The intake receivers turn GitHub issues, Jira issues, Sentry alerts and
 * Dependabot alerts into ingested events; this processor turns those
 * events into exactly ONE Task per `(source, external id)` in the bound
 * Work, and keeps it current:
 *
 *   * first sight of an issue / incident → a Task is filed in the Work
 *     the event routed to (link, culprit, level, last-seen release,
 *     environment and project in the body) and the dedup key is
 *     persisted as an `external_issue_links` row
 *     (UNIQUE `(userId, source, externalIssueId)`) pointing at it;
 *   * every later revision (re-label, transition, repeated alert,
 *     re-fired webhook) finds that row and posts ONE comment on the
 *     existing Task — it never files a second one;
 *   * a retry of the very same drained row (the drain re-runs kind
 *     processors when a later fan-out step failed) is a no-op, keyed on
 *     the link's `lastIngestedEventId`.
 *
 * It is a kind processor on the ingest spine (registered at boot like
 * `TriggerEventFiringService`), so it runs inside the drain: filing is
 * asynchronous (seconds to a minute after the webhook), retry-safe and
 * dependency-free of the receivers. It files INTO THE BOUND WORK only —
 * an event that routed to no Work is left alone (a trigger may still
 * act on it); the Work is loaded and checked against the event's owner
 * before a Task is created under its tenant / organization scope, so
 * neither the payload nor the route can pick a Work the owner does not
 * hold.
 *
 * Failure posture: infrastructure errors are rethrown so the drain
 * retries the row next tick; permanent refusals (no Work, Work
 * unavailable, a description the secret scanner rejects even after
 * redaction) are logged and swallowed so one bad event never wedges the
 * batch. If the dedup row cannot be written after the Task was created,
 * the just-created Task is removed again before rethrowing — otherwise
 * the retry would file a second one.
 */
@Injectable()
export class TriageTaskFilerService implements OnModuleInit {
    private readonly logger = new Logger(TriageTaskFilerService.name);

    constructor(
        private readonly eventIngest: EventIngestService,
        private readonly links: ExternalIssueLinkService,
        private readonly works: WorkRepository,
        private readonly tasks: TasksService,
        private readonly taskRows: TaskRepository,
        private readonly chat: TaskChatService,
    ) {}

    onModuleInit(): void {
        this.eventIngest.registerKindProcessor({
            kinds: TRIAGE_EVENT_KINDS,
            process: async (event: IngestedEvent) => {
                await this.process(event);
            },
        });
    }

    /** File or refresh the triage Task for one drained intake event. */
    async process(event: IngestedEvent): Promise<TriageOutcome> {
        const externalIssueId = event.subjectExternalId;
        if (!externalIssueId) {
            return { outcome: 'skipped', reason: 'no-external-id' };
        }

        const existing = await this.links.find(event.userId, event.source, externalIssueId);
        if (existing) {
            if (existing.lastIngestedEventId === event.id) {
                // Retry of this very row — already filed / commented.
                return { outcome: 'noop', taskId: existing.taskId };
            }
            const task = await this.taskRows.findByIdAndUser(existing.taskId, event.userId);
            if (task) {
                return this.refresh(event, existing, task, externalIssueId);
            }
            // The linked Task was deleted — fall through and file a fresh
            // one; `link()` re-points the row instead of duplicating it.
            this.logger.warn(
                `Triage link for ${event.source}/${externalIssueId} points at a missing Task ${existing.taskId}; filing a new one`,
            );
        }

        return this.file(event, externalIssueId);
    }

    private async refresh(
        event: IngestedEvent,
        existing: ExternalIssueLink,
        task: Task,
        externalIssueId: string,
    ): Promise<TriageOutcome> {
        let commented = false;
        try {
            await this.chat.post(
                event.userId,
                {
                    taskId: task.id,
                    authorType: 'user',
                    authorId: event.userId,
                    body: redactSecrets(renderTriageUpdate(event, { title: existing.title }))
                        .cleaned,
                },
                {},
                {
                    tenantId: task.tenantId ?? null,
                    organizationId: task.organizationId ?? null,
                },
            );
            commented = true;
        } catch (error) {
            // Best-effort: the Task stays current through the link refresh
            // below even when the comment is refused (size / secret scan).
            this.logger.warn(
                `Triage comment on Task ${task.id} for ${event.source}/${externalIssueId} failed: ${this.messageOf(error)}`,
            );
        }

        const facts = triageFactsOf(event);
        await this.links.link({
            userId: event.userId,
            taskId: task.id,
            source: event.source,
            externalIssueId,
            externalKey: triageExternalKeyOf(event),
            title: facts.title,
            url: facts.url ?? existing.url ?? null,
            tenantId: existing.tenantId ?? task.tenantId ?? null,
            organizationId: existing.organizationId ?? task.organizationId ?? null,
            lastIngestedEventId: event.id,
            lastSeenAt: event.occurredAt,
        });
        return { outcome: 'updated', taskId: task.id, commented };
    }

    private async file(event: IngestedEvent, externalIssueId: string): Promise<TriageOutcome> {
        if (!event.workId) {
            this.logger.debug(
                `Triage: ${event.source}/${externalIssueId} routed to no Work; nothing filed`,
            );
            return { outcome: 'skipped', reason: 'no-work' };
        }
        const work = await this.works.findById(event.workId);
        if (!work || work.userId !== event.userId) {
            // The Work is gone, or is not this owner's — never file into it.
            this.logger.warn(
                `Triage: Work ${event.workId} is unavailable to user ${event.userId}; nothing filed for ${event.source}/${externalIssueId}`,
            );
            return { outcome: 'skipped', reason: 'work-unavailable' };
        }
        const scope = {
            tenantId: work.tenantId ?? null,
            organizationId: work.organizationId ?? null,
        };

        const facts = triageFactsOf(event);
        const title = renderTriageTitle(event);
        const description = redactSecrets(renderTriageBody(event)).cleaned;

        let task: Task;
        try {
            task = await this.tasks.create(
                event.userId,
                {
                    title,
                    description,
                    labels: [TRIAGE_LABEL, `source:${event.source}`],
                    priority: PRIORITY[triagePriorityOf(facts.level)],
                    workId: work.id,
                    createdByType: 'user',
                    createdById: event.userId,
                },
                scope,
            );
        } catch (error) {
            if (error instanceof BadRequestException) {
                // Permanent refusal (validation / secret scan) — retrying
                // every tick would only repeat it.
                this.logger.warn(
                    `Triage Task for ${event.source}/${externalIssueId} was refused: ${this.messageOf(error)}`,
                );
                return { outcome: 'skipped', reason: 'rejected' };
            }
            throw error;
        }

        try {
            await this.links.link({
                userId: event.userId,
                taskId: task.id,
                source: event.source,
                externalIssueId,
                externalKey: triageExternalKeyOf(event),
                title: facts.title,
                url: facts.url ?? null,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                lastIngestedEventId: event.id,
                lastSeenAt: event.occurredAt,
            });
        } catch (error) {
            // Without the dedup row the drain's retry would file a SECOND
            // Task — undo the first so the retry starts clean.
            this.logger.warn(
                `Triage link for ${event.source}/${externalIssueId} failed after Task ${task.id} was created; removing the Task so the retry cannot duplicate it: ${this.messageOf(error)}`,
            );
            try {
                await this.tasks.remove(event.userId, task.id, scope);
            } catch (removeError) {
                this.logger.error(
                    `Triage: could not remove orphaned Task ${task.id}: ${this.messageOf(removeError)}`,
                );
            }
            throw error;
        }

        this.logger.log(
            `Triage Task ${task.slug ?? task.id} filed in Work ${work.id} for ${event.source}/${externalIssueId}`,
        );
        return { outcome: 'filed', taskId: task.id };
    }

    private messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

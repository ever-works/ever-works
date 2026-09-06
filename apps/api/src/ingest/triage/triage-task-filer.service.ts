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
    TaskStatus,
    TasksService,
    type Task,
} from '@ever-works/agent/tasks-domain';
import { redactSecrets } from '@ever-works/agent/utils';
import {
    TRIAGE_EVENT_KINDS,
    TRIAGE_LABEL,
    TRIAGE_REGRESSION_LABEL,
    TRIAGE_UPDATE_BUCKET_MS,
    isTriageRepeatAlert,
    renderTriageBody,
    renderTriageSupersededNote,
    renderTriageTitle,
    renderTriageUpdate,
    triageExternalKeyOf,
    triageFactsOf,
    triagePriorityOf,
    triageRegressionOf,
    triageStillActiveOf,
    type TriageFileContext,
    type TriagePriority,
    type TriageRegressionSignal,
} from './triage-task-body';

const PRIORITY: Record<TriagePriority, TaskPriority> = {
    p1: TaskPriority.P1,
    p2: TaskPriority.P2,
    p3: TaskPriority.P3,
    p4: TaskPriority.P4,
};

/**
 * Task states that mean the work is finished. A regression signal that
 * arrives while the Task is in one of these — and ONLY then — files a
 * fresh Task; everything else is a comment on the one that exists.
 */
const CLOSED_TASK_STATUSES: readonly TaskStatus[] = [TaskStatus.DONE, TaskStatus.CANCELLED];

/** What the filer did with one drained event. */
export type TriageOutcome =
    | { readonly outcome: 'filed'; readonly taskId: string }
    | {
          readonly outcome: 'refiled';
          readonly taskId: string;
          readonly supersededTaskId: string;
          readonly regressionCount: number;
          readonly signal: string;
      }
    | { readonly outcome: 'updated'; readonly taskId: string; readonly commented: boolean }
    | { readonly outcome: 'noop'; readonly taskId: string }
    | {
          readonly outcome: 'skipped';
          readonly reason: 'no-external-id' | 'no-work' | 'work-unavailable' | 'rejected';
      };

/** `file()`'s internal result — carries the Task so a caller can name it. */
type FileResult =
    | { readonly outcome: 'filed'; readonly taskId: string; readonly task: Task }
    /** A concurrent filer won the dedup key; its Task is the survivor. */
    | { readonly outcome: 'deduped'; readonly taskId: string }
    | Extract<TriageOutcome, { outcome: 'skipped' }>;

/**
 * How `file()` must write the dedup row.
 *
 * `repoint: false` is a FIRST link and is insert-only, so a concurrent
 * filer that got there first keeps the row and this caller's Task is
 * removed instead of being orphaned. `repoint: true` is a deliberate
 * re-point (a regression superseding a closed Task, or re-filing after
 * the linked Task was deleted) and carries the row's existing
 * observability fields forward so a revision that omits them — a Jira
 * transition with no `issue.self`, a Sentry issue whose permalink fails
 * to parse — cannot NULL a deep link the row already had.
 */
interface LinkWriteMode {
    readonly repoint: boolean;
    readonly previousUrl?: string | null;
    readonly previousExternalKey?: string | null;
}

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
 *     existing Task — it never files a second one. Repeated ALERTS for
 *     an unchanged issue are additionally coalesced to one comment per
 *     {@link TRIAGE_UPDATE_BUCKET_MS}: a comment costs a chat row, an
 *     activity row and a Memory write, so commenting on every alert
 *     moved the pager from the board into the comment stream rather than
 *     removing it. Anything that CHANGED still comments immediately;
 *   * a retry of the very same drained row (the drain re-runs kind
 *     processors when a later fan-out step failed) is a no-op, keyed on
 *     the link's `lastIngestedEventId`.
 *
 * ## The one case where dedup yields: a REGRESSION
 *
 * Dedup that never yields is not dedup, it is amnesia: an issue that was
 * fixed, closed and then came back would post a comment onto a Task
 * nobody looks at any more, and the fleet would never hear about it.
 * So the filer files a NEW Task when — and only when — BOTH hold:
 *
 *   1. the vendor said it came back ({@link triageRegressionOf}: a
 *      GitHub `reopened`, a Sentry `unresolved` / `unarchived`, a
 *      Dependabot `reopened` / `reintroduced` / `auto_reopened`, a Jira
 *      transition back out of a done-named status); and
 *   2. the Task the dedup key points at is already CLOSED
 *      (`done` / `cancelled`).
 *
 * Both halves matter. Without (1) a chatty vendor would re-file forever;
 * without (2) a regression on work still in flight would fork the board.
 * A Sentry issue that alerts two thousand times still produces exactly
 * one Task, because an `event_alert` is not a regression signal WHILE
 * THE TASK IS OPEN.
 *
 * There is a second, weaker signal for exactly one case: a repeated
 * alert arriving on a Task somebody marked `done`
 * ({@link triageStillActiveOf}). The fix did not hold, so the work
 * re-opens. It is still one Task — the re-file leaves an OPEN Task, so
 * every following alert is an ordinary comment — and it is what makes a
 * regression recoverable: {@link triageRegressionOf} is a pure function
 * of a single event, so the vendor's explicit signal is a ONE-SHOT that
 * a temporarily unavailable Work would otherwise consume forever.
 * `cancelled` is excluded: that is a human saying "do not act on this".
 *
 * The dedup row is then RE-POINTED at the new Task (the key itself never
 * changes — it stays `(userId, source, externalIssueId)`), its
 * `regressionCount` is incremented so the history is queryable, and the
 * superseded Task gets one comment naming its replacement. If the new
 * Task cannot be filed (the event routed to no Work, the Work is gone,
 * the body was refused), the filer falls back to commenting on the
 * existing Task — a regression is never silently dropped.
 *
 * It is a kind processor on the ingest spine (registered at boot like
 * `TriggerEventFiringService`), so it runs inside the drain: filing is
 * asynchronous (the drain is a FIVE-MINUTE cron, so a Task appears
 * within a few minutes of the webhook — not seconds), retry-safe and
 * dependency-free of the receivers. Retry-safety is per-row and holds
 * for SEQUENTIAL retries; concurrent drains are excluded upstream
 * (`event-ingest-tick` is `concurrencyLimit: 1` and
 * `EventIngestService.processBatch` is single-flight), and the first
 * link is written insert-only so even a cross-process race cannot leave
 * an orphaned Task behind. It files INTO THE BOUND WORK only —
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
                const reopen = this.reopenSignalFor(event, task);
                if (reopen) {
                    const refiled = await this.refile(
                        event,
                        existing,
                        task,
                        externalIssueId,
                        reopen,
                    );
                    // `null` = the new Task could not be filed; keep the
                    // closed one current rather than losing the revision.
                    // The signal is NOT lost with it: a still-active alert
                    // re-carries it on the next delivery (see
                    // `reopenSignalFor`), so the work re-opens as soon as
                    // the Work claim is back.
                    if (refiled) return refiled;
                }
                return this.refresh(event, existing, task, externalIssueId);
            }
            // The linked Task was deleted — fall through and file a fresh
            // one; `link()` re-points the row instead of duplicating it.
            this.logger.warn(
                `Triage link for ${event.source}/${externalIssueId} points at a missing Task ${existing.taskId}; filing a new one`,
            );
            return this.asOutcome(
                await this.file(event, externalIssueId, {}, this.repointOf(existing)),
            );
        }

        return this.asOutcome(await this.file(event, externalIssueId));
    }

    /**
     * Does this event re-open work on the Task the dedup key points at?
     *
     * Two ways, and the Task's own state decides which applies:
     *
     *  1. the VENDOR said it came back ({@link triageRegressionOf}) and
     *     the Task is closed (`done` or `cancelled`) — unchanged;
     *  2. the error is STILL HAPPENING ({@link triageStillActiveOf}) and
     *     the Task is `done`. A repeated alert is not a regression while
     *     the Task is open — that is what keeps two thousand alerts to
     *     one Task — but arriving after somebody marked the work done, it
     *     says the fix did not hold, and unlike (1) it is re-carried by
     *     every subsequent alert instead of being a one-shot that a
     *     temporarily-unavailable Work silently consumes.
     *
     * `cancelled` is deliberately excluded from (2): "we decided not to
     * act on this" is a human decision a repeated alert must not undo.
     */
    private reopenSignalFor(event: IngestedEvent, task: Task): TriageRegressionSignal | null {
        const vendor = triageRegressionOf(event);
        if (vendor) {
            return CLOSED_TASK_STATUSES.includes(task.status) ? vendor : null;
        }
        return task.status === TaskStatus.DONE ? triageStillActiveOf(event) : null;
    }

    /** Carry an existing link's observability fields through a re-point. */
    private repointOf(existing: ExternalIssueLink): LinkWriteMode {
        return {
            repoint: true,
            previousUrl: existing.url ?? null,
            previousExternalKey: existing.externalKey ?? null,
        };
    }

    /** `file()`'s internal result, as the public outcome type. */
    private asOutcome(filed: FileResult): TriageOutcome {
        switch (filed.outcome) {
            case 'filed':
                return { outcome: 'filed', taskId: filed.taskId };
            // A concurrent filer holds the dedup key; its Task is the one
            // the row points at, and this call already removed its own.
            case 'deduped':
                return { outcome: 'noop', taskId: filed.taskId };
            default:
                return filed;
        }
    }

    /**
     * A closed Task's issue came back: file a fresh Task, re-point the
     * dedup row at it, and tell the closed one where the work moved.
     *
     * Returns `null` when the new Task could not be filed at all — the
     * caller then falls back to the ordinary comment path, so a
     * regression that arrives while the Work is unavailable still shows
     * up somewhere a human reads.
     */
    private async refile(
        event: IngestedEvent,
        existing: ExternalIssueLink,
        superseded: Task,
        externalIssueId: string,
        regression: TriageRegressionSignal,
    ): Promise<TriageOutcome | null> {
        const regressionCount = (existing.regressionCount ?? 0) + 1;
        const filed = await this.file(
            event,
            externalIssueId,
            {
                regression,
                supersedesTaskRef: superseded.slug ?? superseded.id,
                regressionCount,
            },
            this.repointOf(existing),
        );
        if (filed.outcome !== 'filed') {
            this.logger.warn(
                `Triage: ${event.source}/${externalIssueId} regressed (${regression.signal}) but no new Task could be filed (${
                    filed.outcome === 'skipped' ? filed.reason : 'a concurrent filer won the link'
                }); commenting on the closed Task ${superseded.id} instead`,
            );
            return null;
        }

        try {
            await this.chat.post(
                event.userId,
                {
                    taskId: superseded.id,
                    authorType: 'user',
                    authorId: event.userId,
                    body: redactSecrets(
                        renderTriageSupersededNote(event, {
                            regression,
                            newTaskRef: filed.task.slug ?? filed.task.id,
                        }),
                    ).cleaned,
                },
                {},
                {
                    tenantId: superseded.tenantId ?? null,
                    organizationId: superseded.organizationId ?? null,
                },
            );
        } catch (error) {
            // Best-effort: the new Task and the re-pointed dedup row are
            // the load-bearing half; the breadcrumb on the closed Task is
            // not worth failing (and retrying) the whole row for.
            this.logger.warn(
                `Triage: could not annotate superseded Task ${superseded.id} for ${event.source}/${externalIssueId}: ${this.messageOf(error)}`,
            );
        }

        this.logger.log(
            `Triage: ${event.source}/${externalIssueId} regressed (${regression.signal}); Task ${filed.taskId} supersedes closed Task ${superseded.id} (re-opening #${regressionCount})`,
        );
        return {
            outcome: 'refiled',
            taskId: filed.taskId,
            supersededTaskId: superseded.id,
            regressionCount,
            signal: regression.signal,
        };
    }

    private async refresh(
        event: IngestedEvent,
        existing: ExternalIssueLink,
        task: Task,
        externalIssueId: string,
    ): Promise<TriageOutcome> {
        let commented = false;
        if (this.shouldComment(event, existing)) {
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
                // Best-effort: the Task stays current through the link
                // refresh below even when the comment is refused (size /
                // secret scan).
                this.logger.warn(
                    `Triage comment on Task ${task.id} for ${event.source}/${externalIssueId} failed: ${this.messageOf(error)}`,
                );
            }
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

    /**
     * Should this revision post a comment, or only refresh the row?
     *
     * Everything that actually CHANGED comments immediately: a state
     * transition, a regression signal, a new title. Only a REPEATED
     * ALERT — the same unchanged issue firing again — is coalesced, to
     * at most one comment per {@link TRIAGE_UPDATE_BUCKET_MS}.
     *
     * Without this, a flapping Sentry issue posted one comment per
     * drained alert on a single Task: a `task_chat_messages` row plus a
     * `TASK_COMMENTED` activity row each, on top of the drain's own
     * activity row and a Memory write (often an embedding call). That is
     * thousands of rows and provider calls for one issue, and the
     * salience filter cannot shed any of it — it scores incident traffic
     * UP. The bucket is derived from the stored `lastSeenAt` and the
     * event's own `occurredAt`, so it needs no extra state and behaves
     * identically across pods and restarts.
     */
    private shouldComment(event: IngestedEvent, existing: ExternalIssueLink): boolean {
        if (!isTriageRepeatAlert(event)) return true;
        if (triageRegressionOf(event)) return true;

        const previousTitle = existing.title ?? null;
        const nextTitle = triageFactsOf(event).title;
        if (previousTitle !== null && previousTitle !== nextTitle) return true;

        const last = existing.lastSeenAt?.getTime();
        const now = event.occurredAt?.getTime();
        if (last === undefined || Number.isNaN(last) || now === undefined || Number.isNaN(now)) {
            return true;
        }
        return (
            Math.floor(now / TRIAGE_UPDATE_BUCKET_MS) !== Math.floor(last / TRIAGE_UPDATE_BUCKET_MS)
        );
    }

    private async file(
        event: IngestedEvent,
        externalIssueId: string,
        context: TriageFileContext = {},
        mode: LinkWriteMode = { repoint: false },
    ): Promise<FileResult> {
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

        const regressed = Boolean(context.regression);
        const facts = triageFactsOf(event);
        const title = renderTriageTitle(event, regressed);
        const description = redactSecrets(renderTriageBody(event, context)).cleaned;

        let task: Task;
        try {
            task = await this.tasks.create(
                event.userId,
                {
                    title,
                    description,
                    labels: [
                        TRIAGE_LABEL,
                        `source:${event.source}`,
                        ...(regressed ? [TRIAGE_REGRESSION_LABEL] : []),
                    ],
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

        let link: ExternalIssueLink;
        try {
            link = await this.links.link({
                userId: event.userId,
                taskId: task.id,
                source: event.source,
                externalIssueId,
                // A re-point carries the row's existing deep link and key
                // forward: a revision that happens not to carry them
                // (a Jira transition with no `issue.self`, a Sentry issue
                // whose permalink will not parse) must not NULL what the
                // row already knew.
                externalKey: triageExternalKeyOf(event) ?? mode.previousExternalKey ?? null,
                title: facts.title,
                url: facts.url ?? mode.previousUrl ?? null,
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                lastIngestedEventId: event.id,
                lastSeenAt: event.occurredAt,
                // Only a regression moves the counter; a first link and a
                // re-file after the Task was deleted leave it untouched.
                ...(context.regressionCount !== undefined
                    ? { regressionCount: context.regressionCount }
                    : {}),
                // A FIRST link never steals the key from a concurrent
                // filer — see `LinkWriteMode`.
                ...(mode.repoint ? {} : { onlyIfAbsent: true }),
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

        // Insert-only write and somebody else holds the key: a concurrent
        // drain filed first. Their Task is the one the dedup row points
        // at, so this one is an orphan — remove it rather than leave two
        // triage Tasks for one issue on the board.
        if (!mode.repoint && link.taskId !== task.id) {
            this.logger.warn(
                `Triage: ${event.source}/${externalIssueId} was filed concurrently as Task ${link.taskId}; removing the duplicate Task ${task.id}`,
            );
            try {
                await this.tasks.remove(event.userId, task.id, scope);
            } catch (removeError) {
                this.logger.error(
                    `Triage: could not remove duplicate Task ${task.id}: ${this.messageOf(removeError)}`,
                );
            }
            return { outcome: 'deduped', taskId: link.taskId };
        }

        this.logger.log(
            `Triage Task ${task.slug ?? task.id} filed in Work ${work.id} for ${event.source}/${externalIssueId}`,
        );
        return { outcome: 'filed', taskId: task.id, task };
    }

    private messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

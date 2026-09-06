import { Injectable, Logger, Optional } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import {
    TaskAssigneeRepository,
    UserTaskCounterRepository,
} from '../database/repositories/task-side.repositories';
import { computeNextTemplateOccurrence, cloneRecurringTaskAsInstance } from './recurrence';
import { TaskNotificationService } from './task-notification.service';
import { TaskTransitionService } from './task-transition.service';
import { TaskGraphFanoutService, type TaskFanoutSummary } from './task-graph-fanout.service';
import { TaskStatus, type Task } from '../entities/task.entity';

export interface RecurrenceDispatchEntry {
    templateId: string;
    templateSlug: string;
    scheduledFor: string;
    outcome: 'spawned' | 'skipped' | 'failed';
    instanceId?: string;
    instanceSlug?: string;
    nextOccurrenceAt?: string | null;
    /** How the spawned instance's agent dispatch went. */
    dispatch?: 'dispatched' | 'no-agent' | 'not-attempted';
    message?: string;
}

export interface RecurrenceDispatchSummary {
    limit: number;
    dueCount: number;
    spawned: number;
    skipped: number;
    failed: number;
    entries: RecurrenceDispatchEntry[];
}

export interface ScheduleDispatchEntry {
    taskId: string;
    taskSlug: string;
    scheduledFor: string;
    outcome: 'dispatched' | 'no-agent' | 'skipped' | 'failed';
    message?: string;
}

export interface ScheduleDispatchSummary {
    limit: number;
    dueCount: number;
    dispatched: number;
    noAgent: number;
    skipped: number;
    failed: number;
    entries: ScheduleDispatchEntry[];
}

/**
 * Tasks feature — Phase 17.6 + schedule-modes upgrade.
 *
 * Cron-fed dispatcher with three scans per tick:
 *
 *  1. `dispatchDue` — recurring Task templates whose
 *     `nextOccurrenceAt <= now` (RRULE or cron cadence). CAS-claims each
 *     one, clones a fresh instance (KEEPING the owner tuple incl.
 *     agentId/teamId/goalId), COPIES the template's assignee rows, and
 *     dispatches the instance through the same gated path a board "Run"
 *     uses. Previously spawned instances carried no agent binding at all
 *     and sat inert — that is the defect this upgrade fixes.
 *
 *  2. `dispatchDueScheduled` — one-shot Tasks whose `scheduledAt <= now`
 *     and are unclaimed. CAS-claims via `scheduleClaimedAt`, then
 *     dispatches the Task itself (no clone).
 *
 *  3. `dispatchUnblockedTodo` — the task-graph fan-out (slice AH):
 *     TODO Tasks with zero OPEN blockers, started through the ordinary
 *     gated path, bounded per owner and OFF by default. It lives behind
 *     this class rather than beside it because this service is already
 *     in the worker RPC map, so a new METHOD needs no plumbing while a
 *     new service would need edits in five files.
 *
 * Both paths resolve the run agent as: agent assignees (fan-out, one run
 * per agent) → the Task's own `agentId`. When nothing resolves, the
 * `task_run_no_agent` notification fires instead of a silent skip — the
 * Task stays visibly queued (`todo`) for a human to pick up.
 *
 * The CAS guards are what stop two concurrent dispatcher workers from
 * double-spawning / double-dispatching at the same boundary. Mirrors
 * `AgentScheduleDispatcherService.dispatchDue` posture end to end.
 */
@Injectable()
export class TaskRecurrenceDispatcherService {
    private readonly logger = new Logger(TaskRecurrenceDispatcherService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly counter: UserTaskCounterRepository,
        // Third-pass fix: emit `task_recurrence_fired` after a successful
        // spawn so the dead enum branch in TaskNotificationService is
        // actually reachable. Optional() — when unbound (unit tests),
        // spawn still completes.
        @Optional() private readonly notifications?: TaskNotificationService,
        // Schedule-modes upgrade — assignee copy + agent dispatch.
        // Appended LAST + Optional so every positional construction in
        // the existing specs keeps compiling; graphs without them spawn
        // instances exactly as before (inert), never crash.
        @Optional() private readonly assignees?: TaskAssigneeRepository,
        @Optional() private readonly transitions?: TaskTransitionService,
        // Task-graph fan-out (slice AH). Appended LAST + Optional for the
        // same positional-construction reason as the two above; unbound,
        // `dispatchUnblockedTodo` reports a tick that started nothing.
        @Optional() private readonly fanout?: TaskGraphFanoutService,
    ) {}

    async dispatchDue(limit = 50, now: Date = new Date()): Promise<RecurrenceDispatchSummary> {
        const templates = await this.tasks.findDueRecurringTemplates(limit, now);
        const summary: RecurrenceDispatchSummary = {
            limit,
            dueCount: templates.length,
            spawned: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const template of templates) {
            const scheduledFor = template.nextOccurrenceAt!;
            try {
                const nextSlot = computeNextTemplateOccurrence({
                    rule: template.recurrenceRule ?? null,
                    cron: template.recurrenceCron ?? null,
                    from: scheduledFor,
                    recurrenceEndsAt: template.recurrenceEndsAt ?? null,
                    recurrenceMaxOccurrences: template.recurrenceMaxOccurrences ?? null,
                    recurrenceOccurredCount: (template.recurrenceOccurredCount ?? 0) + 1,
                });

                // CAS-claim — only one worker advances nextOccurrenceAt.
                const claimed = await this.tasks.casClaimRecurrence(
                    template.id,
                    scheduledFor,
                    nextSlot,
                );
                if (!claimed) {
                    summary.skipped += 1;
                    summary.entries.push({
                        templateId: template.id,
                        templateSlug: template.slug,
                        scheduledFor: scheduledFor.toISOString(),
                        outcome: 'skipped',
                        message: 'CAS lost — another dispatcher claimed first',
                    });
                    continue;
                }

                // Spawn the instance with a fresh per-user slug.
                const nextNumber = await this.counter.nextSlug(template.userId);
                const slug = `T-${nextNumber}`;
                const instanceData = {
                    ...cloneRecurringTaskAsInstance(template),
                    slug,
                };
                const instance = await this.tasks.create(instanceData);

                // Copy the template's assignee rows so the instance is
                // runnable by the same actors. Best-effort: a copy failure
                // must not fail the spawn (the instance still exists).
                await this.copyAssignees(template.id, instance.id);

                // Dispatch through THE gated path (concurrency valve,
                // credits precheck, denorm — all apply unchanged).
                const dispatchOutcome = await this.dispatchInstance(instance);

                summary.spawned += 1;
                summary.entries.push({
                    templateId: template.id,
                    templateSlug: template.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: 'spawned',
                    instanceId: instance.id,
                    instanceSlug: instance.slug,
                    nextOccurrenceAt: nextSlot?.toISOString() ?? null,
                    dispatch: dispatchOutcome,
                });

                // Third-pass fix: in-app notification for the spawned
                // instance. Discriminator uses recurrenceOccurredCount
                // (advanced by casClaimRecurrence) so consecutive
                // occurrences don't dedup-collapse. Best-effort.
                if (this.notifications) {
                    void this.notifications
                        .emit(
                            'task_recurrence_fired',
                            {
                                taskId: instance.id,
                                taskSlug: instance.slug,
                                taskTitle: instance.title,
                                occurrenceCount: (template.recurrenceOccurredCount ?? 0) + 1,
                            },
                            [template.userId],
                        )
                        .catch(() => undefined);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `Failed to spawn recurrence instance for ${template.id}: ${message}`,
                    err as Error,
                );
                summary.failed += 1;
                summary.entries.push({
                    templateId: template.id,
                    templateSlug: template.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: 'failed',
                    message,
                });
            }
        }

        return summary;
    }

    /**
     * Schedule-modes upgrade — the one-shot half of the cron tick.
     * Walks due `scheduledAt` Tasks, CAS-claims each, and dispatches
     * the Task itself.
     */
    async dispatchDueScheduled(
        limit = 50,
        now: Date = new Date(),
    ): Promise<ScheduleDispatchSummary> {
        const due = await this.tasks.findDueScheduledTasks(limit, now);
        const summary: ScheduleDispatchSummary = {
            limit,
            dueCount: due.length,
            dispatched: 0,
            noAgent: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const task of due) {
            const scheduledFor = task.scheduledAt!;
            try {
                const claimed = await this.tasks.casClaimSchedule(task.id, scheduledFor, now);
                if (!claimed) {
                    summary.skipped += 1;
                    summary.entries.push({
                        taskId: task.id,
                        taskSlug: task.slug,
                        scheduledFor: scheduledFor.toISOString(),
                        outcome: 'skipped',
                        message: 'CAS lost — another dispatcher claimed first',
                    });
                    continue;
                }

                // Make the fire visible on the board: a backlog one-shot
                // becomes actionable `todo`. Best-effort CAS — a Task
                // already moved by its owner is left alone.
                if (task.status === TaskStatus.BACKLOG) {
                    await this.tasks
                        .casUpdateStatus(task.id, TaskStatus.BACKLOG, {
                            status: TaskStatus.TODO,
                        })
                        .catch(() => false);
                }

                const outcome = await this.dispatchInstance(task);
                if (outcome === 'dispatched') {
                    summary.dispatched += 1;
                } else {
                    summary.noAgent += 1;
                }
                summary.entries.push({
                    taskId: task.id,
                    taskSlug: task.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: outcome === 'dispatched' ? 'dispatched' : 'no-agent',
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `Failed to dispatch scheduled task ${task.id}: ${message}`,
                    err as Error,
                );
                summary.failed += 1;
                summary.entries.push({
                    taskId: task.id,
                    taskSlug: task.slug,
                    scheduledFor: scheduledFor.toISOString(),
                    outcome: 'failed',
                    message,
                });
            }
        }

        return summary;
    }

    /**
     * Task-graph fan-out (slice AH) — the third scan of the tick.
     *
     * A thin delegation on purpose: `TaskGraphFanoutService` owns every
     * rule (the blocker predicate, the per-owner bound, the stop flag and
     * the admission probe), and this method only makes it reachable from
     * the cron through the RPC surface this class already has.
     *
     * Unbound service ⇒ a summary that plainly says nothing ran, never a
     * silent zero that reads like "there was nothing to do".
     */
    async dispatchUnblockedTodo(limit?: number): Promise<TaskFanoutSummary> {
        if (!this.fanout) {
            return {
                limit: limit ?? 0,
                candidateCount: 0,
                started: 0,
                skipped: 0,
                failed: 0,
                halted: false,
                disabled: true,
                maxStartsPerOwner: 0,
                entries: [],
            };
        }
        return this.fanout.dispatchUnblocked(limit);
    }

    // ── internals ─────────────────────────────────────────────────

    private async copyAssignees(templateTaskId: string, instanceTaskId: string): Promise<void> {
        if (!this.assignees) return;
        try {
            const rows = await this.assignees.findByTaskId(templateTaskId);
            for (const row of rows) {
                await this.assignees
                    .add(instanceTaskId, row.assigneeType, row.assigneeId)
                    .catch((err) =>
                        this.logger.warn(
                            `Assignee copy failed for instance ${instanceTaskId}: ${err}`,
                        ),
                    );
            }
        } catch (err) {
            this.logger.warn(`Assignee lookup failed for template ${templateTaskId}: ${err}`);
        }
    }

    /**
     * Dispatch a spawned/scheduled Task through
     * `TaskTransitionService.dispatchAgentRun` — THE single dispatch
     * path, so the concurrency gate and the board denorm apply
     * unchanged. Agent resolution: agent assignees (one run per agent,
     * mirroring the drag-to-in-progress fan-out) → the Task's own
     * `agentId` column. No resolvable agent → `task_run_no_agent`
     * notification instead of a silent skip.
     */
    private async dispatchInstance(
        task: Task,
    ): Promise<'dispatched' | 'no-agent' | 'not-attempted'> {
        if (!this.transitions) return 'not-attempted';

        const agentIds = new Set<string>();
        if (this.assignees) {
            try {
                const agentRows = await this.assignees.findAgentAssignees(task.id);
                for (const row of agentRows) agentIds.add(row.assigneeId);
            } catch (err) {
                this.logger.warn(`Agent-assignee lookup failed for task ${task.id}: ${err}`);
            }
        }
        if (agentIds.size === 0 && task.agentId) {
            agentIds.add(task.agentId);
        }

        if (agentIds.size === 0) {
            if (this.notifications) {
                void this.notifications
                    .emit(
                        'task_run_no_agent',
                        {
                            taskId: task.id,
                            taskSlug: task.slug,
                            taskTitle: task.title,
                        },
                        [task.userId],
                    )
                    .catch(() => undefined);
            }
            return 'no-agent';
        }

        // Dedup discriminator: a spawned recurrence instance has a fresh
        // task id per occurrence, so the generation suffices; a RE-scheduled
        // one-shot reuses its task id, so the fired slot itself is the
        // discriminator (two fires of the same Task at different slots must
        // not dedup-collapse).
        const discriminator =
            task.scheduledAt?.getTime() ?? (task.recurrenceOccurredCount ?? 0) + 1;
        let anyDispatched = false;
        for (const agentId of agentIds) {
            // dispatchAgentRun never throws — failures are recorded on the
            // run row; a parked (gated) run still counts as dispatched
            // because it is visibly queued and will be promoted.
            const result = await this.transitions.dispatchAgentRun(task, agentId, {
                dedupKey: `${task.id}:${agentId}:schedule:${discriminator}`,
            });
            if (result.dispatched || result.parked) anyDispatched = true;
        }
        return anyDispatched ? 'dispatched' : 'no-agent';
    }
}

import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from '@nestjs/common';
import { TaskStatus } from '../entities/task.entity';
import type { Task } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import {
    TaskAssigneeRepository,
    TaskBlockRepository,
    TaskApproverRepository,
} from '../database/repositories/task-side.repositories';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AGENT_TASK_EXECUTE_DISPATCHER, type AgentTaskExecuteDispatcher } from './task-dispatcher';
import { TaskNotificationService } from './task-notification.service';

/**
 * Tasks feature — Phase 12.1.
 *
 * State-machine guard for Task status transitions per
 * `features/task-tracking/plan.md §3` + spec table:
 *
 *   backlog → todo, cancelled
 *   todo → in_progress, blocked, cancelled
 *   in_progress → in_review, blocked, done, cancelled
 *   in_review → in_progress, blocked, done, cancelled
 *   blocked → todo, in_progress, cancelled  (unblock restores previousStatus)
 *   done → in_progress (re-open) — soft path
 *   cancelled → (terminal)
 *
 * Side-effect rules:
 *   - any → in_progress: set startedAt if null.
 *   - any → done: requires (a) no open blockers AND (b) when
 *     requireAllApprovers=true, all approvers in 'approved' state.
 *     Sets completedAt.
 *   - any → blocked: stash current status into previousStatus.
 *   - blocked → *: clear previousStatus on success.
 *   - force=true override skips approver-gate but NOT cycle/blocker
 *     check (those are integrity rules, not policy).
 */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
    [TaskStatus.BACKLOG]: [TaskStatus.TODO, TaskStatus.CANCELLED],
    [TaskStatus.TODO]: [TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
    [TaskStatus.IN_PROGRESS]: [
        TaskStatus.IN_REVIEW,
        TaskStatus.BLOCKED,
        TaskStatus.DONE,
        TaskStatus.CANCELLED,
    ],
    [TaskStatus.IN_REVIEW]: [
        TaskStatus.IN_PROGRESS,
        TaskStatus.BLOCKED,
        TaskStatus.DONE,
        TaskStatus.CANCELLED,
    ],
    [TaskStatus.BLOCKED]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
    [TaskStatus.DONE]: [TaskStatus.IN_PROGRESS],
    [TaskStatus.CANCELLED]: [],
};

export interface TransitionOptions {
    force?: boolean;
}

@Injectable()
export class TaskTransitionService {
    private readonly logger = new Logger(TaskTransitionService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly blocks: TaskBlockRepository,
        private readonly approvers: TaskApproverRepository,
        @Optional() private readonly assignees?: TaskAssigneeRepository,
        @Optional() private readonly runs?: AgentRunRepository,
        @Optional()
        @Inject(AGENT_TASK_EXECUTE_DISPATCHER)
        private readonly dispatcher?: AgentTaskExecuteDispatcher,
        // Review-fix I13: in-app notification emit on every transition
        // + blocked event. Optional so unit-test fixtures without the
        // Notifications graph still work.
        @Optional() private readonly notifications?: TaskNotificationService,
    ) {}

    /**
     * Assert + execute. Throws on disallowed move or unsatisfied gate.
     * Returns the resulting Task (re-fetched from DB so callers see the
     * side-effect columns).
     */
    async transition(task: Task, to: TaskStatus, opts: TransitionOptions = {}): Promise<Task> {
        const from = task.status;
        if (!ALLOWED[from]?.includes(to)) {
            throw new BadRequestException(`Cannot transition Task from ${from} to ${to}.`);
        }

        // Blocker gate — Review-fix C6: spec FR-9 requires 409 on
        // `→ in_progress` AND `→ done` when blockers are open. `force`
        // is an approver-gate override only; it must NOT bypass the
        // blocker gate (blockers are an integrity rule, not policy).
        if (to === TaskStatus.IN_PROGRESS || to === TaskStatus.DONE) {
            const openBlockers = await this.findOpenBlockers(task.id);
            if (openBlockers.length > 0) {
                throw new ConflictException(
                    `Task cannot transition to ${to} — has ${openBlockers.length} open blocker(s).`,
                );
            }
        }
        // → done: approver gate (separate from blocker — `force` overrides this one only).
        if (to === TaskStatus.DONE) {
            if (!opts.force && task.requireAllApprovers) {
                const ok = await this.approvers.allApproved(task.id);
                if (!ok) {
                    throw new ConflictException(
                        'Task cannot transition to done — not all approvers have approved (pass force=true to override).',
                    );
                }
            }
        }

        const patch: Partial<Task> = { status: to };
        if (to === TaskStatus.IN_PROGRESS && !task.startedAt) {
            patch.startedAt = new Date();
        }
        if (to === TaskStatus.DONE) {
            patch.completedAt = new Date();
        }
        if (to === TaskStatus.BLOCKED) {
            patch.previousStatus = from;
        }
        if (from === TaskStatus.BLOCKED) {
            patch.previousStatus = null;
        }

        await this.tasks.updateById(task.id, patch);
        const refreshed = await this.tasks.findById(task.id);
        if (!refreshed) {
            throw new ConflictException(`Task ${task.id} vanished after transition.`);
        }

        // Phase 15.3 dispatch hook: any → in_progress fans out to
        // `agent-task-execute` for every Agent assignee. Dedup key is
        // `${taskId}:${agentId}:${generation}` where `generation` is
        // the `recurrenceOccurredCount + 1` on the parent template (or
        // just `1` for non-recurring tasks) — keeps a rapid status
        // flip-flop from double-firing the same Agent.
        if (to === TaskStatus.IN_PROGRESS && this.dispatcher && this.assignees) {
            void this.fanOutAgentExecutions(refreshed).catch((err) =>
                this.logger.warn(`Agent fan-out failed for task ${refreshed.id}: ${err}`),
            );
        }

        // Review-fix I1: auto-unblock dependents when this Task itself
        // transitions to a "resolved" state. Done/cancelled both
        // count — a cancelled blocker no longer holds anything back.
        // Best-effort: failures log WARN but don't bubble.
        if (to === TaskStatus.DONE || to === TaskStatus.CANCELLED) {
            void this.autoUnblockResolvedTasks(refreshed.id).catch((err) =>
                this.logger.warn(`autoUnblock cascade failed for task ${refreshed.id}: ${err}`),
            );
        }

        // Review-fix I13: in-app notifications. `task_status_changed`
        // on every transition, `task_blocked` when the destination is
        // `blocked`. Best-effort — emit failures log inside
        // TaskNotificationService and don't bubble.
        //
        // Third-pass fix: populate `blockerTaskId` on `task_blocked`
        // so the C7 dedup discriminator distinguishes repeat blocks
        // of the same Task (e.g. blocked → unblocked → blocked).
        // Without this the discriminator falls back to toStatus
        // ("blocked") and every repeat firing collapses to the same
        // dedup key, silently swallowed by NotificationService.
        if (this.notifications) {
            void this.notifications
                .emit('task_status_changed', {
                    taskId: refreshed.id,
                    taskSlug: refreshed.slug,
                    taskTitle: refreshed.title,
                    fromStatus: from,
                    toStatus: to,
                })
                .catch(() => undefined);
            if (to === TaskStatus.BLOCKED) {
                void (async () => {
                    try {
                        const openBlockerIds = await this.findOpenBlockers(refreshed.id);
                        await this.notifications!.emit('task_blocked', {
                            taskId: refreshed.id,
                            taskSlug: refreshed.slug,
                            taskTitle: refreshed.title,
                            fromStatus: from,
                            toStatus: to,
                            // Distinguishes repeat block events; absent only
                            // when the Task is blocked with zero open blockers
                            // (rare race window during a block-add transaction).
                            blockerTaskId: openBlockerIds[0],
                        });
                    } catch (err) {
                        this.logger.warn(`task_blocked emit failed for ${refreshed.id}: ${err}`);
                    }
                })();
            }
        }

        return refreshed;
    }

    private async fanOutAgentExecutions(task: Task): Promise<void> {
        if (!this.dispatcher || !this.assignees) return;
        const agentAssignees = await this.assignees.findAgentAssignees(task.id);
        if (agentAssignees.length === 0) return;
        const generation = (task.recurrenceOccurredCount ?? 0) + 1;
        for (const assignee of agentAssignees) {
            const dedupKey = `${task.id}:${assignee.assigneeId}:${generation}`;
            try {
                // Pre-create a queued AgentRun row so the worker can find
                // it via findInFlightForTaskAgent (T6 chat-dedup posture).
                if (this.runs) {
                    await this.runs.createQueued({
                        agentId: assignee.assigneeId,
                        userId: task.userId,
                        triggerKind: 'task',
                        taskId: task.id,
                    });
                }
                await this.dispatcher.enqueue({
                    agentId: assignee.assigneeId,
                    userId: task.userId,
                    taskId: task.id,
                    dedupKey,
                });
            } catch (err) {
                this.logger.warn(
                    `Failed to dispatch agent-task-execute for ${assignee.assigneeId}: ${err}`,
                );
            }
        }
    }

    private async findOpenBlockers(taskId: string): Promise<string[]> {
        const rows = await this.blocks.findByTaskId(taskId);
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.blockedByTaskId);
        const open: string[] = [];
        for (const id of ids) {
            const t = await this.tasks.findById(id);
            if (t && t.status !== TaskStatus.DONE && t.status !== TaskStatus.CANCELLED) {
                open.push(id);
            }
        }
        return open;
    }

    /** Pure helper for tests + UI affordance check — no DB I/O. */
    canTransition(from: TaskStatus, to: TaskStatus): boolean {
        return ALLOWED[from]?.includes(to) ?? false;
    }

    /**
     * Review-fix I1: auto-unblock side effect per spec FR-10.
     * Called from `TasksService.removeBlocker` (after each block row
     * deletion) and from the transition path (when a blocker Task
     * itself transitions to `done` / `cancelled`). For every Task
     * currently in `blocked` status that has no remaining open
     * blockers, transition it back to its `previousStatus`.
     *
     * Idempotent + best-effort: a failed sub-transition logs WARN
     * but never bubbles, so resolving a blocker can't be rolled back
     * by a transient downstream failure.
     */
    async autoUnblockResolvedTasks(blockerTaskId: string): Promise<{ unblocked: string[] }> {
        // Find every Task that was blocked BY this Task and is still in `blocked` status.
        const blockedTaskIds = await this.blocks.findTasksBlockedBy(blockerTaskId).catch(() => []);
        const unblocked: string[] = [];
        for (const blockedTaskId of blockedTaskIds) {
            if (await this.tryUnblockSingleTask(blockedTaskId)) {
                unblocked.push(blockedTaskId);
            }
        }
        return { unblocked };
    }

    /**
     * Second-pass fix: the `removeBlocker` path needs the OPPOSITE
     * lookup direction from `autoUnblockResolvedTasks`. There, the
     * blocker resolves → look for everything it was blocking. Here,
     * the dependent task just lost a blocker → check whether it has
     * any blockers left, and if not, restore. Public so
     * `TasksService.removeBlocker` can call it directly.
     */
    async recheckUnblockFor(taskId: string): Promise<boolean> {
        return this.tryUnblockSingleTask(taskId);
    }

    private async tryUnblockSingleTask(taskId: string): Promise<boolean> {
        const blocked = await this.tasks.findById(taskId).catch(() => null);
        if (!blocked || blocked.status !== TaskStatus.BLOCKED) return false;
        const openBlockers = await this.findOpenBlockers(taskId);
        if (openBlockers.length > 0) return false;
        const restoreTo = blocked.previousStatus ?? TaskStatus.TODO;
        try {
            // Re-enter transition() so blocker/approver gates + side
            // effects (previousStatus clear, startedAt set) all fire
            // consistently with a user-driven move.
            await this.transition(blocked, restoreTo, { force: false });
            return true;
        } catch (err) {
            this.logger.warn(
                `autoUnblock failed for task ${taskId} (restore→${restoreTo}): ${err}`,
            );
            return false;
        }
    }
}

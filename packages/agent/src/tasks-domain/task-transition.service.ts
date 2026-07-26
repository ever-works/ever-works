import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from '@nestjs/common';
import { TaskStatus } from '../entities/task.entity';
import type { Task, TaskActorType } from '../entities/task.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { resolveChecksPolicy } from './task-gates';
import {
    TaskAssigneeRepository,
    TaskBlockRepository,
    TaskApproverRepository,
} from '../database/repositories/task-side.repositories';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import {
    AGENT_TASK_EXECUTE_DISPATCHER,
    JOB_RUNTIME_NOT_CONFIGURED_REASON,
    TERMINAL_SESSION_STARTER,
    type AgentTaskExecuteDispatcher,
    type TerminalSessionStarter,
} from './task-dispatcher';
import { TaskNotificationService } from './task-notification.service';
import { TaskRunDenormService } from './task-run-denorm.service';
// Value import (not `import type`): Nest resolves the @Optional() class
// injection below via emitted design:paramtypes metadata, which needs the
// real class reference. No cycle: run-dispatch-gate.service imports only
// task-dispatcher (leaf), the run repository, and config.
import { RunDispatchGateService } from '../agents/run-dispatch-gate.service';

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
    /**
     * Who is driving this transition (quality gates, Wave 3 M8). Callers
     * acting on an Agent's behalf — the run finalizer, the workspace
     * finalize step, the agent `transitionTask` chat tool — pass 'agent';
     * human/API callers omit it (or pass 'user'). Only 'agent' activates
     * the red-gate review refusal; every human path is unaffected.
     */
    actorType?: TaskActorType;
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
        // Kanban run cockpit (Wave 2) — latest-run denorm on dispatch.
        // Optional for the same unit-test-fixture reason as the rest.
        @Optional() private readonly runDenorm?: TaskRunDenormService,
        // Run orchestration (Wave 4 M2) — concurrency gate consulted per
        // assignee before the job-runtime enqueue. Appended LAST so every
        // positional `new TaskTransitionService(...)` in the specs keeps
        // compiling; Optional so fixtures without it dispatch ungated.
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
        // Quality gates (Wave 3 M8) — Work lookup for the checksPolicy of
        // the agent-driven review-entry rule. Appended LAST (same
        // positional-constructor reasoning as above); Optional so fixtures
        // without it skip the rule entirely (fail toward the status quo).
        @Optional() private readonly works?: WorkRepository,
        // Streaming terminal — starts the `terminal-session` job for a
        // freshly-dispatched run that asked for one. Appended LAST (same
        // positional-constructor reasoning as above); Optional so fixtures
        // and installs without a job runtime simply never start a session.
        @Optional()
        @Inject(TERMINAL_SESSION_STARTER)
        private readonly terminalSessions?: TerminalSessionStarter,
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
        // Quality gates (Wave 3 M8) — AGENT-driven review entry is refused
        // while the Task's latest run has a non-passing gate under a
        // 'required' checks policy: red work never enters the review column
        // on an agent's say-so. Scope is deliberately narrow:
        //   - only `in_progress → in_review` (the review-entry edge);
        //   - only when the caller declared `actorType: 'agent'` — every
        //     human transition is untouched, a human can always pull a Task
        //     into review deliberately;
        //   - `force` overrides it exactly like the approver gate (policy
        //     override, never an integrity override);
        //   - refusal requires a POSITIVE 'red' / 'skipped' verdict on the
        //     latest run — missing deps, lookup failures, no runs, or a
        //     null gateStatus all fail toward allowing the move (status
        //     quo), mirroring `resolveChecksPolicy`'s posture. 'skipped'
        //     blocks too: under 'required', a gate that did not run must
        //     never pass anything.
        if (
            from === TaskStatus.IN_PROGRESS &&
            to === TaskStatus.IN_REVIEW &&
            opts.actorType === 'agent' &&
            !opts.force
        ) {
            const refusingGate = await this.findRefusingGateStatus(task);
            if (refusingGate) {
                throw new ConflictException(
                    `Task cannot transition to in_review — the latest agent run's quality gate is '${refusingGate}' and this Work requires passing acceptance checks. Fix the failing checks (or pass force=true to override).`,
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

        // Atomic CAS on the source state: the UPDATE only lands while the row
        // is still at `from`, so a concurrent identical-transition burst
        // resolves to exactly ONE winner. The losers (affected=0) raced after
        // the winner already advanced the status, so they get the same
        // read-time "Cannot transition" 400 a sequential stale caller would —
        // never a silent double-write or a 5xx.
        const won = await this.tasks.casUpdateStatus(task.id, from, patch);
        if (!won) {
            throw new BadRequestException(`Cannot transition Task from ${from} to ${to}.`);
        }
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
            await this.dispatchAgentRun(task, assignee.assigneeId, { generation });
        }
    }

    /**
     * THE dispatch path for one (Task, Agent) pair — gate admit →
     * pre-created queued run → board denorm → job-runtime enqueue →
     * triggerRunId stamp, with the loud-degradation error handling.
     *
     * Extracted from {@link fanOutAgentExecutions} (which is now a loop
     * over it) so that board dispatch — "Run" on a kanban card — enters
     * exactly the same path a drag-to-in-progress does. There is
     * deliberately ONE implementation: a second one would be a second
     * place for the concurrency valve, the credits precheck, the denorm
     * mirror and the dispatch-failed bookkeeping to drift.
     *
     * Never throws: every failure is recorded on the run row and
     * reported in the result, because the transition that hosts this
     * call must not be rolled back by a dispatch hiccup.
     *
     * @param opts.generation dedup generation for the runtime key. The
     *        transition path passes the recurrence generation so a rapid
     *        status flip-flop cannot double-fire; explicit callers pass
     *        their own discriminator.
     */
    async dispatchAgentRun(
        task: Task,
        agentId: string,
        opts: { generation?: number; dedupKey?: string } = {},
    ): Promise<{
        runId: string | null;
        /** True when the job runtime accepted the run this call. */
        dispatched: boolean;
        /** True when the run row exists but was parked by the gate. */
        parked: boolean;
        queuedReason?: string;
        /** Set when the enqueue failed; the run is marked failed. */
        error?: string;
    }> {
        if (!this.dispatcher) {
            return { runId: null, dispatched: false, parked: false, error: 'no-dispatcher' };
        }
        const generation = opts.generation ?? (task.recurrenceOccurredCount ?? 0) + 1;
        const dedupKey = opts.dedupKey ?? `${task.id}:${agentId}:${generation}`;
        {
            let run: { id: string } | null = null;
            try {
                // Run orchestration (Wave 4 M2) — consult the concurrency
                // gate BEFORE enqueuing. Fail-open on gate errors: the gate
                // is a safety valve, and a broken valve must never stop
                // legitimate dispatch (the valve's own counting query is the
                // only thing that can throw here).
                let admission: { admitted: boolean; queuedReason?: string } = {
                    admitted: true,
                };
                // Pre-create a queued AgentRun row so the worker can find
                // it via findInFlightForTaskAgent (T6 chat-dedup posture).
                // `workId` is denormalized here (Wave 4 M1) so per-Work
                // concurrency counts + the Sessions view need no join.
                //
                // Handed to the gate as the `reserve` half of admission so
                // the count and this insert are one critical section under
                // the advisory lock (no-op off Postgres).
                const reserve = async (verdict: {
                    admitted: boolean;
                    queuedReason?: string;
                }): Promise<void> => {
                    run = this.runs
                        ? await this.runs.createQueued({
                              agentId,
                              userId: task.userId,
                              triggerKind: 'task',
                              taskId: task.id,
                              workId: task.workId ?? null,
                              queuedReason: verdict.admitted
                                  ? null
                                  : (verdict.queuedReason ?? 'concurrency-limit'),
                          })
                        : null;
                };
                if (this.dispatchGate) {
                    try {
                        admission = await this.dispatchGate.admit(
                            {
                                userId: task.userId,
                                workId: task.workId ?? null,
                                organizationId: task.organizationId ?? null,
                            },
                            reserve,
                        );
                    } catch (gateErr) {
                        this.logger.warn(
                            `Dispatch gate admit failed for task ${task.id} — failing open: ${gateErr}`,
                        );
                    }
                    // Defence in depth: the gate calls `reserve` on every
                    // path INCLUDING its own fail-open, but a gate stub
                    // that ignores the callback must not silently produce a
                    // dispatch with no run row behind it.
                    if (!run) await reserve(admission);
                } else {
                    await reserve(admission);
                }
                // TypeScript's control-flow analysis cannot see the
                // assignment that happens inside `reserve`, so it still
                // believes `run` is the `null` it was initialised to.
                // Re-widen to the declared type.
                run = run as { id: string } | null;
                // Kanban run cockpit — mirror the freshly-queued run onto the
                // Task row so the board chip appears before the worker even
                // claims it. The service is best-effort by contract (logs +
                // never throws), so this cannot break the dispatch.
                if (run) {
                    await this.runDenorm?.recordQueued(task.id, run.id);
                }
                // Over-limit: the run row exists (parked, queuedReason set)
                // but the job-runtime enqueue is SKIPPED. The drain hook on
                // terminal transitions promotes it when a slot frees.
                if (!admission.admitted) {
                    this.logger.log(
                        `Run for agent ${agentId} on task ${task.id} parked by dispatch gate (${admission.queuedReason}).`,
                    );
                    return {
                        runId: run?.id ?? null,
                        dispatched: false,
                        parked: true,
                        queuedReason: admission.queuedReason ?? 'concurrency-limit',
                    };
                }
                const handle = await this.dispatcher.enqueue({
                    agentId,
                    userId: task.userId,
                    taskId: task.id,
                    dedupKey,
                    runId: run?.id,
                });
                // Stamp the Trigger.dev id so a cancel arriving before the
                // worker starts can still reach the remote run. Swallowed
                // separately: the enqueue already succeeded, so a stamp
                // failure must not reach the catch below and mark this run
                // dispatch-failed while its Trigger.dev run is executing.
                if (run && handle?.runId) {
                    // try/catch, not .catch() — a synchronous throw (or a
                    // repository stub without the method) would escape before
                    // .catch() could attach, land in the catch below, and mark
                    // a successfully-dispatched run as dispatch-failed.
                    try {
                        await this.runs?.setTriggerRunId(run.id, handle.runId);
                    } catch (stampErr) {
                        this.logger.warn(
                            `Failed to stamp triggerRunId on AgentRun ${run.id}: ${stampErr}`,
                        );
                    }
                }
                // Streaming terminal — a run that asked for a long-lived
                // interactive session gets one alongside its execution.
                // `requirePersistent` means the starter refuses anything
                // that did not ask, so the one-shot path is untouched.
                //
                // Its own try/catch, NOT the enqueue's: the dispatch has
                // already succeeded here, and a terminal-session hiccup
                // must never fall through to the rollback below and mark a
                // live run dispatch-failed. Fire-and-forget for the same
                // reason the fan-out itself is — the run does not wait on
                // its terminal.
                if (run && this.terminalSessions) {
                    const terminalRunId = run.id;
                    const terminalAgentId = agentId;
                    try {
                        void this.terminalSessions
                            .startForRun({
                                userId: task.userId,
                                agentId: terminalAgentId,
                                runId: terminalRunId,
                                requirePersistent: true,
                            })
                            .catch((terminalErr) =>
                                this.logger.warn(
                                    `Terminal session start failed for AgentRun ${terminalRunId}: ${terminalErr}`,
                                ),
                            );
                    } catch (terminalErr) {
                        this.logger.warn(
                            `Terminal session start threw for AgentRun ${terminalRunId}: ${terminalErr}`,
                        );
                    }
                }

                return { runId: run?.id ?? null, dispatched: true, parked: false };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // Loud degradation: an unconfigured job runtime is a distinct,
                // ACTIONABLE failure (install-level misconfiguration), not a
                // transient dispatch error — record it under its stable marker
                // so the run-detail UI and the health banner tell one story.
                const notConfigured =
                    err instanceof Error && err.name === 'JobRuntimeNotConfiguredError';
                const reason = notConfigured
                    ? `${JOB_RUNTIME_NOT_CONFIGURED_REASON}: ${message}`
                    : `dispatch-failed: ${message}`;
                this.logger.warn(`Failed to dispatch agent-task-execute for ${agentId}: ${reason}`);
                if (run) {
                    try {
                        await this.runs?.markDispatchFailed(run.id, reason);
                    } catch (failErr) {
                        this.logger.warn(
                            `Failed to mark orphan AgentRun ${run.id} failed: ${failErr}`,
                        );
                    }
                    // Kanban run cockpit — mirror the dispatch failure so the
                    // board chip doesn't show a phantom queued run forever.
                    await this.runDenorm?.recordTerminal(task.id, run.id, 'failed');
                }
                return {
                    runId: run?.id ?? null,
                    dispatched: false,
                    parked: false,
                    error: reason,
                };
            }
        }
    }

    /**
     * Quality gates (Wave 3 M8) — resolve the gate verdict that refuses an
     * agent-driven review entry, or null when the move is allowed.
     *
     * Returns 'red' | 'skipped' ONLY when every link in the chain resolved
     * positively: the Task belongs to a Work, that Work's checksPolicy is
     * 'required', a latest run exists, and its persisted gateStatus is a
     * non-passing verdict. Every failure/absence returns null — the rule
     * must never invent a blocking verdict out of a lookup hiccup.
     */
    private async findRefusingGateStatus(task: Task): Promise<'red' | 'skipped' | null> {
        if (!task.workId || !this.works || !this.runs) return null;
        let work: Awaited<ReturnType<WorkRepository['findById']>> = null;
        try {
            work = await this.works.findById(task.workId);
        } catch (err) {
            this.logger.warn(
                `Gate rule: Work ${task.workId} lookup failed for task ${task.id} — allowing: ${err}`,
            );
            return null;
        }
        if (resolveChecksPolicy(work) !== 'required') return null;
        let latestRun: { gateStatus?: string | null } | null = null;
        try {
            latestRun = await this.runs.findLatestForTask(task.id);
        } catch (err) {
            this.logger.warn(
                `Gate rule: latest-run lookup failed for task ${task.id} — allowing: ${err}`,
            );
            return null;
        }
        const gateStatus = latestRun?.gateStatus;
        return gateStatus === 'red' || gateStatus === 'skipped' ? gateStatus : null;
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

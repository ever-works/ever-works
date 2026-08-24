import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
    GOAL_EXECUTION_TARGETS,
    Goal,
    type GoalDoDCriterion,
    type GoalExecutionTarget,
    type GoalLoopStatus,
} from '../entities/goal.entity';
import { GoalEvent, type GoalEventKind } from '../entities/goal-event.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { Task, TaskPriority, TaskStatus } from '../entities/task.entity';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { NotificationCategory, NotificationType } from '../entities/notification.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationService } from '../notifications/notification.service';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { RunSteeringService } from '../agents/run-steering.service';
import { RunDispatchGateService } from '../agents/run-dispatch-gate.service';
import { AGENT_RUN_CANCELLER, type AgentRunCanceller } from '../agents/agent-run-canceller';
import { TasksService } from '../tasks-domain/tasks.service';
import { TaskTransitionService } from '../tasks-domain/task-transition.service';
import {
    ownershipRelationScopeOf,
    ownershipScopeOf,
    ownershipWhereWith,
    type OwnershipScope,
} from '../database/ownership-scope';
import {
    dodProgressSignature,
    normalizeDoDCriteria,
    summarizeDoD,
    validateDoDCriteria,
} from './goal-dod';
import {
    decideGoalLoop,
    formatUsd,
    type GoalLoopDecision,
    type GoalRoutingCandidate,
} from './goal-orchestrator-rules';
import {
    toGoalDto,
    toGoalEventDto,
    type GoalAdvanceResult,
    type GoalAdvanceSummary,
    type GoalDto,
    type GoalEventDto,
    type GoalSessionDto,
    type PatchGoalDoDCriterionInput,
    type UpdateGoalLimitsInput,
} from './types';

/** Label prefix every auto-created iteration Task carries. */
export const GOAL_ITERATION_LABEL = 'goal-iteration';

/** Upper bounds on the limit fields (defense against a hand-edited row). */
export const MAX_SPEND_CAP_CENTS = 100_000_000; // $1,000,000
export const MAX_WALL_CLOCK_LIMIT_HOURS = 24 * 365;
export const MAX_STUCK_THRESHOLD_ITERATIONS = 1000;
export const MAX_SESSION_BUDGET_MINUTES = 24 * 60;
export const MAX_GRACE_PERIOD_MINUTES = 24 * 60;
export const MAX_MODEL_HINT_CHARS = 120;

/** Bound on a single nudge so a steering message can't be a payload. */
export const MAX_NUDGE_CHARS = 2000;

/** How many iteration Tasks one rollup will ever consider. */
const MAX_GOAL_TASKS = 500;

const ACTIVE_RUN_STATUSES = ['queued', 'running'];

/**
 * Autonomy layer — the per-Goal EXECUTION LOOP.
 *
 * A Goal already knew how to measure itself ({@link GoalEvaluationService}
 * reads a metric on a schedule). This service is the other half: it
 * decides whether to keep WORKING on the Goal, who should do the next
 * iteration, and when to stop — and it writes down why, every time.
 *
 * ## An iteration is a Task
 *
 * Nothing here re-implements dispatch. One iteration = one auto-created
 * Task (`[Goal] <title> — iteration N`) filed against the Goal
 * (`tasks.goalId`) and assigned to the routed agent, then handed to
 * `TaskTransitionService.dispatchAgentRun` — the SAME path a human
 * clicking "Run" on a kanban card takes. That is what buys the loop the
 * concurrency valve, the credits precheck, workspace isolation, the
 * quality gates and the run cockpit for free, and it is why the Sessions
 * tab is just "the runs of this Goal's Tasks".
 *
 * ## The decision is a pure function
 *
 * Every branch lives in `decideGoalLoop` (goal-orchestrator-rules.ts).
 * This service does I/O and nothing else: read the Goal, roll up spend
 * from the linked runs, gather routing candidates, ASK, then act on the
 * answer and log it. The decision table is therefore exhaustively
 * testable without a database.
 *
 * ## Degradation is explicit
 *
 * `TasksService` / `TaskTransitionService` / `RunSteeringService` are all
 * `@Optional()`. In an install without them (unit tests, CLI, a worker
 * scope), the loop REFUSES with a clear message instead of silently
 * reporting a dispatch that never happened.
 */
@Injectable()
export class GoalOrchestratorService {
    private readonly logger = new Logger(GoalOrchestratorService.name);

    constructor(
        @InjectRepository(Goal)
        private readonly goals: Repository<Goal>,
        @InjectRepository(GoalEvent)
        private readonly events: Repository<GoalEvent>,
        @InjectRepository(Task)
        private readonly tasks: Repository<Task>,
        @InjectRepository(AgentRun)
        private readonly runs: Repository<AgentRun>,
        // Every collaborator below is @Optional() and appended in a stable
        // order so hand-rolled positional test constructions keep working
        // (the house idiom — see GoalEvaluationService).
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly tasksService?: TasksService,
        @Optional() private readonly transitions?: TaskTransitionService,
        @Optional() private readonly steering?: RunSteeringService,
        @Optional() private readonly agentRuns?: AgentRunRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly notifications?: NotificationService,
        // Cancelling a run is THREE things, not one: the CAS on the row, the
        // remote Trigger.dev cancel, and draining the concurrency slot the
        // cancel just freed. `RunSteeringService`'s docblock says as much
        // ("Duplicating it would fork the CAS + remote-cancel + drain
        // semantics"), so the loop's cancel/restart uses the same three.
        // Both appended LAST + @Optional() per the arity rule above.
        @Optional()
        @Inject(AGENT_RUN_CANCELLER)
        private readonly runCanceller?: AgentRunCanceller,
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
    ) {}

    // ─── limits ─────────────────────────────────────────────────────

    /**
     * Live "Adjust limits" write. `undefined` leaves a field alone;
     * `null` CLEARS it (back to uncapped) — an operator must be able to
     * remove a ceiling, not only raise it.
     */
    async updateLimits(
        userId: string,
        goalId: string,
        input: UpdateGoalLimitsInput,
        scope?: OwnershipScope,
    ): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId, scope);
        const before = this.limitsSnapshot(goal);

        if (input.spendCapCents !== undefined) {
            goal.spendCapCents = this.assertBoundedInt(
                input.spendCapCents,
                'spendCapCents',
                0,
                MAX_SPEND_CAP_CENTS,
            );
        }
        if (input.wallClockLimitHours !== undefined) {
            goal.wallClockLimitHours = this.assertBoundedInt(
                input.wallClockLimitHours,
                'wallClockLimitHours',
                1,
                MAX_WALL_CLOCK_LIMIT_HOURS,
            );
        }
        if (input.stuckThresholdIterations !== undefined) {
            goal.stuckThresholdIterations = this.assertBoundedInt(
                input.stuckThresholdIterations,
                'stuckThresholdIterations',
                1,
                MAX_STUCK_THRESHOLD_ITERATIONS,
            );
        }
        if (input.sessionBudgetMinutes !== undefined) {
            goal.sessionBudgetMinutes = this.assertBoundedInt(
                input.sessionBudgetMinutes,
                'sessionBudgetMinutes',
                1,
                MAX_SESSION_BUDGET_MINUTES,
            );
        }
        if (input.gracePeriodMinutes !== undefined) {
            goal.gracePeriodMinutes = this.assertBoundedInt(
                input.gracePeriodMinutes,
                'gracePeriodMinutes',
                0,
                MAX_GRACE_PERIOD_MINUTES,
            );
        }
        if (input.executionTarget !== undefined) {
            goal.executionTarget = this.assertExecutionTarget(input.executionTarget);
        }
        if (input.plannerModelHint !== undefined) {
            goal.plannerModelHint = this.normalizeHint(input.plannerModelHint);
        }
        if (input.workerModelHint !== undefined) {
            goal.workerModelHint = this.normalizeHint(input.workerModelHint);
        }
        if (input.assignedAgentId !== undefined) {
            goal.assignedAgentId = await this.resolveAssignedAgentId(
                userId,
                input.assignedAgentId,
                ownershipRelationScopeOf(goal),
            );
        }

        const saved = await this.goals.save(goal);
        const after = this.limitsSnapshot(saved);
        await this.recordEvent(saved, {
            kind: 'control',
            message: this.describeLimitChange(before, after),
            metadata: { before, after },
        });
        return toGoalDto(saved);
    }

    // ─── Definition of Done ─────────────────────────────────────────

    /** Replace the whole checklist (operator-authored, already approved). */
    async setDodCriteria(
        userId: string,
        goalId: string,
        criteria: GoalDoDCriterion[] | null,
    ): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        this.assertDod(criteria);
        const beforeSignature = dodProgressSignature(goal.dodCriteria);
        goal.dodCriteria = criteria === null ? null : normalizeDoDCriteria(criteria);
        this.markProgressIfChanged(goal, beforeSignature);

        const saved = await this.goals.save(goal);
        const summary = summarizeDoD(saved.dodCriteria);
        await this.recordEvent(saved, {
            kind: 'dod',
            message:
                `Definition of Done updated — ${summary.done} done, ${summary.waived} waived, ` +
                `${summary.open} open${summary.proposed > 0 ? `, ${summary.proposed} awaiting approval` : ''}.`,
            metadata: { summary },
        });
        await this.recordActivity(saved, ActivityActionType.GOAL_DOD_UPDATED, 'dod-set', {
            summary,
        });
        return toGoalDto(saved);
    }

    /**
     * Append PLANNER-authored criteria for operator approval.
     *
     * The seam a planning run writes through. Proposed criteria are inert:
     * `summarizeDoD` excludes them from the rollup, so a planning run can
     * neither extend nor satisfy the finish line on its own. The operator
     * is notified through the existing notification path.
     */
    async proposeDodCriteria(
        userId: string,
        goalId: string,
        criteria: GoalDoDCriterion[],
    ): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        if (!Array.isArray(criteria) || criteria.length === 0) {
            throw new BadRequestException('At least one proposed criterion is required.');
        }
        const existing = Array.isArray(goal.dodCriteria) ? goal.dodCriteria : [];
        const proposed = normalizeDoDCriteria(
            criteria.map((entry) => ({
                ...entry,
                status: 'open' as const,
                source: 'planner' as const,
                proposed: true,
            })),
        );
        const merged = [...existing, ...proposed];
        this.assertDod(merged);
        goal.dodCriteria = merged;

        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, {
            kind: 'dod',
            message:
                `Planning run proposed ${proposed.length} Definition-of-Done criteria — awaiting ` +
                'operator approval before they count toward completion.',
            metadata: { proposedIds: proposed.map((entry) => entry.id) },
        });
        // Follow-up: when the Inbox surface lands, this becomes an Inbox
        // approval item. It does not exist on this branch's base, so the
        // approval request rides the existing notification path instead —
        // deliberately not silently dropped.
        await this.notifyProposal(saved, proposed.length);
        return toGoalDto(saved);
    }

    /** Approve proposed criteria (all, or the named subset). */
    async approveDodCriteria(
        userId: string,
        goalId: string,
        criterionIds?: string[] | null,
    ): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        const existing = Array.isArray(goal.dodCriteria) ? goal.dodCriteria : [];
        const wanted = criterionIds && criterionIds.length > 0 ? new Set(criterionIds) : null;

        if (wanted) {
            const known = new Set(existing.map((entry) => entry.id));
            const unknown = [...wanted].filter((id) => !known.has(id));
            if (unknown.length > 0) {
                throw new NotFoundException(`Unknown criterion id(s): ${unknown.join(', ')}`);
            }
        }

        let approved = 0;
        const beforeSignature = dodProgressSignature(existing);
        goal.dodCriteria = existing.map((entry) => {
            if (entry.proposed !== true) return entry;
            if (wanted && !wanted.has(entry.id)) return entry;
            approved += 1;
            const { proposed: _proposed, ...rest } = entry;
            return { ...rest, updatedAt: new Date().toISOString() };
        });
        if (approved === 0) {
            throw new BadRequestException('No proposed criteria to approve.');
        }
        this.markProgressIfChanged(goal, beforeSignature);

        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, {
            kind: 'dod',
            message: `Operator approved ${approved} proposed Definition-of-Done criteria.`,
            metadata: { approved },
        });
        await this.recordActivity(saved, ActivityActionType.GOAL_DOD_UPDATED, 'dod-approve', {
            approved,
        });
        return toGoalDto(saved);
    }

    /**
     * Tick / untick / waive ONE criterion.
     *
     * Waiving requires no note by contract, but the note is what makes the
     * waiver auditable, so it is carried onto both the row and the log
     * line whenever supplied.
     */
    async patchDodCriterion(
        userId: string,
        goalId: string,
        criterionId: string,
        patch: PatchGoalDoDCriterionInput,
    ): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        const existing = Array.isArray(goal.dodCriteria) ? goal.dodCriteria : [];
        const target = existing.find((entry) => entry.id === criterionId);
        if (!target) {
            throw new NotFoundException(`Criterion not found`);
        }

        const beforeSignature = dodProgressSignature(existing);
        const updated: GoalDoDCriterion = {
            ...target,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.text !== undefined ? { text: patch.text } : {}),
            ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
            ...(patch.note !== undefined ? { note: patch.note } : {}),
            updatedAt: new Date().toISOString(),
        };
        const next = existing.map((entry) => (entry.id === criterionId ? updated : entry));
        this.assertDod(next);
        goal.dodCriteria = normalizeDoDCriteria(next);
        this.markProgressIfChanged(goal, beforeSignature);

        const saved = await this.goals.save(goal);
        const summary = summarizeDoD(saved.dodCriteria);
        await this.recordEvent(saved, {
            kind: 'dod',
            message:
                `Criterion "${updated.text}" → ${updated.status}` +
                (updated.status === 'waived' && updated.note ? ` (waived: ${updated.note})` : '') +
                ` — ${summary.done} done, ${summary.waived} waived, ${summary.open} open.`,
            metadata: { criterionId, status: updated.status, summary },
        });
        await this.recordActivity(saved, ActivityActionType.GOAL_DOD_UPDATED, 'dod-patch', {
            criterionId,
            status: updated.status,
            summary,
        });
        return toGoalDto(saved);
    }

    // ─── loop control ───────────────────────────────────────────────

    /** Start (or resume) the loop. Idempotent when already running. */
    async startLoop(userId: string, goalId: string): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        if (goal.archivedAt) {
            throw new BadRequestException('Archived Goals cannot run an execution loop.');
        }
        const resuming = goal.loopStatus === 'paused' || goal.loopStatus === 'stuck';
        goal.loopStatus = 'running';
        // The wall-clock anchor is set on the FIRST start and preserved
        // across pause/resume: a limit an operator can reset by pausing for
        // a second is not a limit.
        if (!goal.loopStartedAt) {
            goal.loopStartedAt = new Date();
        }
        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, {
            kind: 'control',
            message: resuming
                ? `Loop resumed at iteration ${saved.iteration}.`
                : 'Loop started — the orchestrator will route the next iteration.',
        });
        await this.recordActivity(
            saved,
            resuming ? ActivityActionType.GOAL_LOOP_RESUMED : ActivityActionType.GOAL_LOOP_STARTED,
            resuming ? 'resume' : 'start',
            { iteration: saved.iteration },
        );
        return toGoalDto(saved);
    }

    /** Operator pause. The in-flight iteration is left to land. */
    async pauseLoop(userId: string, goalId: string): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        if (goal.loopStatus !== 'running') {
            throw new BadRequestException(
                `Loop is not running (state: ${goal.loopStatus ?? 'not started'}).`,
            );
        }
        goal.loopStatus = 'paused';
        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, {
            kind: 'control',
            message: `Loop paused by operator at iteration ${saved.iteration}.`,
        });
        await this.recordActivity(saved, ActivityActionType.GOAL_LOOP_PAUSED, 'pause', {
            iteration: saved.iteration,
        });
        return toGoalDto(saved);
    }

    /**
     * Stop the loop for good. Cancels the in-flight run — unlike pause,
     * cancelling means the work is not wanted, so letting it land would
     * spend budget on an outcome nobody asked for.
     */
    async cancelLoop(userId: string, goalId: string): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        const cancelled = await this.cancelActiveRun(goal, userId);
        goal.loopStatus = 'cancelled';
        goal.activeAgentId = null;
        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, {
            kind: 'complete',
            message:
                `Loop cancelled by operator at iteration ${saved.iteration}` +
                (cancelled ? ' — the in-flight session was cancelled too.' : '.'),
            metadata: { cancelledRunId: cancelled },
        });
        await this.recordActivity(saved, ActivityActionType.GOAL_LOOP_CANCELLED, 'cancel', {
            iteration: saved.iteration,
            cancelledRunId: cancelled,
        });
        return toGoalDto(saved);
    }

    /**
     * Restart the session: cancel whatever is running and immediately
     * route a fresh iteration. The iteration counter still ADVANCES — a
     * restart is a new attempt, and pretending otherwise would make the
     * orchestrator log unreadable.
     */
    async restartSession(userId: string, goalId: string): Promise<GoalAdvanceResult> {
        const goal = await this.findOrThrow(userId, goalId);
        // Same guard as `startLoop`: restart RESURRECTS the loop to
        // `running` and dispatches a paid iteration, so without this an
        // archived Goal — which `advanceDue` deliberately skips and
        // `startLoop` refuses — could still be made to spend money through
        // the restart endpoint.
        if (goal.archivedAt) {
            throw new BadRequestException('Archived Goals cannot run an execution loop.');
        }
        const cancelled = await this.cancelActiveRun(goal, userId);
        goal.loopStatus = 'running';
        if (!goal.loopStartedAt) goal.loopStartedAt = new Date();
        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, {
            kind: 'control',
            message: cancelled
                ? 'Session restarted by operator — the in-flight session was cancelled.'
                : 'Session restarted by operator.',
            metadata: { cancelledRunId: cancelled },
        });
        return this.advanceOne(saved, { force: true });
    }

    /**
     * Inject a steering message into the live iteration run.
     *
     * Reuses `RunSteeringService.steer` — the exact path a chat mention of
     * a busy agent takes. When the run has already gone terminal the
     * steering service reports `new-run` and this REFUSES rather than
     * silently starting one: a nudge is "say this to the thing that is
     * running", and if nothing is running the honest answer is to advance
     * the loop instead.
     */
    async nudge(
        userId: string,
        goalId: string,
        message: string,
    ): Promise<{ goal: GoalDto; runId: string; queuedCount?: number }> {
        const goal = await this.findOrThrow(userId, goalId);
        const text = typeof message === 'string' ? message.trim() : '';
        if (!text) {
            throw new BadRequestException('A nudge needs a non-empty message.');
        }
        if (text.length > MAX_NUDGE_CHARS) {
            throw new BadRequestException(
                `A nudge must be at most ${MAX_NUDGE_CHARS} characters (received ${text.length}).`,
            );
        }
        if (!this.steering) {
            throw new BadRequestException(
                'Run steering is not available on this install — nudging is disabled.',
            );
        }

        const active = await this.findActiveRun(goal.id);
        if (!active) {
            throw new BadRequestException(
                'This Goal has no session in flight to nudge. Advance the loop to start one.',
            );
        }

        const outcome = await this.steering.steer({ runId: active.id, userId, message: text });
        if (outcome.dispatched !== 'injected') {
            throw new BadRequestException(
                'The session finished before the nudge could be delivered. Advance the loop to start a fresh one.',
            );
        }

        await this.recordEvent(goal, {
            kind: 'nudge',
            message: `Operator nudged iteration ${goal.iteration}: ${text}`,
            agentId: active.agentId,
            taskId: active.taskId ?? null,
            metadata: { runId: active.id, queuedCount: outcome.queuedCount },
        });
        await this.recordActivity(goal, ActivityActionType.GOAL_ITERATION_NUDGED, 'nudge', {
            runId: active.id,
            iteration: goal.iteration,
        });

        const result: { goal: GoalDto; runId: string; queuedCount?: number } = {
            goal: toGoalDto(goal),
            runId: active.id,
        };
        if (outcome.queuedCount !== undefined) {
            result.queuedCount = outcome.queuedCount;
        }
        return result;
    }

    // ─── archive ────────────────────────────────────────────────────

    async archive(userId: string, goalId: string): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        if (goal.archivedAt) return toGoalDto(goal);
        goal.archivedAt = new Date();
        // Archiving a Goal whose loop is running would leave the
        // orchestrator advancing something the operator has retired.
        if (goal.loopStatus === 'running') {
            goal.loopStatus = 'paused';
        }
        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, { kind: 'control', message: 'Goal archived.' });
        await this.recordActivity(saved, ActivityActionType.GOAL_ARCHIVED, 'archive', {});
        return toGoalDto(saved);
    }

    async unarchive(userId: string, goalId: string): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        if (!goal.archivedAt) return toGoalDto(goal);
        goal.archivedAt = null;
        const saved = await this.goals.save(goal);
        await this.recordEvent(saved, { kind: 'control', message: 'Goal unarchived.' });
        await this.recordActivity(saved, ActivityActionType.GOAL_UNARCHIVED, 'unarchive', {});
        return toGoalDto(saved);
    }

    // ─── reads ──────────────────────────────────────────────────────

    /** The orchestrator log, newest first. */
    async listEvents(userId: string, goalId: string, limit = 100): Promise<GoalEventDto[]> {
        await this.findOrThrow(userId, goalId);
        const rows = await this.events.find({
            where: { goalId },
            order: { createdAt: 'DESC' },
            take: Math.min(500, Math.max(1, limit)),
        });
        return rows.map(toGoalEventDto);
    }

    /**
     * The Sessions tab: every iteration Task with its latest run.
     *
     * A Task with NO run is still listed — hiding it would make a loop
     * that failed to dispatch look idle rather than broken.
     */
    async listSessions(userId: string, goalId: string): Promise<GoalSessionDto[]> {
        await this.findOrThrow(userId, goalId);
        const { tasks, runsByTask } = await this.loadGoalWork(goalId);
        return tasks.map((task) => {
            const run = runsByTask.get(task.id) ?? null;
            return {
                taskId: task.id,
                taskSlug: task.slug,
                taskTitle: task.title,
                taskStatus: task.status,
                iteration: this.iterationFromTitle(task.title),
                agentId: task.agentId ?? run?.agentId ?? null,
                runId: run?.id ?? null,
                runStatus: run?.status ?? task.latestRunStatus ?? null,
                startedAt: run?.startedAt ?? null,
                finishedAt: run?.finishedAt ?? null,
                durationMs: run?.durationMs ?? null,
                costCents: run?.costCents ?? null,
                summary: run?.summary ?? null,
            };
        });
    }

    /**
     * Recompute `spentCents` from the linked runs and persist it.
     *
     * A DERIVED number, refreshed on demand rather than incremented on the
     * side: a counter that misses one terminal run under-reports forever,
     * and a budget that under-reports is not a budget.
     */
    async rollupSpend(userId: string, goalId: string): Promise<GoalDto> {
        const goal = await this.findOrThrow(userId, goalId);
        const spent = await this.computeSpend(goal.id);
        if (goal.spentCents !== spent) {
            goal.spentCents = spent;
            return toGoalDto(await this.goals.save(goal));
        }
        return toGoalDto(goal);
    }

    // ─── advance ────────────────────────────────────────────────────

    /** Operator-triggered advance (`POST /me/goals/:id/advance`). */
    async advance(userId: string, goalId: string): Promise<GoalAdvanceResult> {
        const goal = await this.findOrThrow(userId, goalId);
        return this.advanceOne(goal);
    }

    /**
     * One orchestrator tick: advance every Goal whose loop is running.
     *
     * Cheap when nothing is running — one indexed lookup
     * (`idx_goals_loop_status`) returning zero rows, since a NULL
     * `loopStatus` (every Goal that never opted in) never matches.
     */
    async advanceDue(limit = 50): Promise<GoalAdvanceSummary> {
        const due = await this.goals.find({
            where: { loopStatus: 'running', archivedAt: IsNull() },
            order: { updatedAt: 'ASC' },
            take: limit,
        });

        const summary: GoalAdvanceSummary = {
            limit,
            dueCount: due.length,
            dispatched: 0,
            completed: 0,
            paused: 0,
            stuck: 0,
            failed: 0,
            results: [],
        };

        for (const goal of due) {
            try {
                const result = await this.advanceOne(goal);
                summary.results.push(result);
                if (result.action === 'dispatch') summary.dispatched += 1;
                else if (result.action === 'complete') summary.completed += 1;
                else if (result.action === 'pause') summary.paused += 1;
                else if (result.action === 'stuck') summary.stuck += 1;
            } catch (error) {
                // One broken Goal must never stop the tick for the others.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Goal ${goal.id} advance failed: ${message}`);
                summary.failed += 1;
                summary.results.push({
                    goalId: goal.id,
                    action: 'noop',
                    reasonCode: 'advance-failed',
                    reasoning: message,
                    iteration: goal.iteration ?? 0,
                });
            }
        }

        return summary;
    }

    /**
     * The single advance implementation both the cron and the manual
     * button go through.
     *
     * @param opts.force skips the `loopStatus === 'running'` short-circuit
     *        (restart has just set it, and a manual advance on a paused
     *        loop should still report `noop` honestly).
     */
    private async advanceOne(
        goal: Goal,
        opts: { force?: boolean } = {},
    ): Promise<GoalAdvanceResult> {
        const spent = await this.computeSpend(goal.id);
        if (goal.spentCents !== spent) {
            goal.spentCents = spent;
            await this.goals.save(goal);
        }

        const activeRun = await this.findActiveRun(goal.id);
        const candidates = await this.resolveCandidates(goal);
        const decision = decideGoalLoop({
            loopStatus: opts.force ? 'running' : (goal.loopStatus ?? null),
            dod: summarizeDoD(goal.dodCriteria),
            iteration: goal.iteration ?? 0,
            lastProgressIteration: goal.lastProgressIteration ?? 0,
            stuckThresholdIterations: goal.stuckThresholdIterations ?? null,
            spendCapCents: goal.spendCapCents ?? null,
            spentCents: spent,
            wallClockLimitHours: goal.wallClockLimitHours ?? null,
            loopStartedAt: goal.loopStartedAt ?? null,
            gracePeriodMinutes: goal.gracePeriodMinutes ?? null,
            hasRunInFlight: activeRun !== null,
            candidates,
            now: new Date(),
        });

        switch (decision.action) {
            case 'dispatch':
                return this.applyDispatch(goal, decision);
            case 'complete':
                return this.applyTerminal(goal, decision, 'done');
            case 'pause':
                return this.applyTerminal(goal, decision, 'paused');
            case 'stuck':
                return this.applyTerminal(goal, decision, 'stuck');
            default:
                // `wait` / `noop` change nothing and are NOT logged: the
                // orchestrator log must stay readable, and a per-minute
                // cron that writes "still running" every tick would bury
                // the decisions that matter under thousands of non-events.
                return {
                    goalId: goal.id,
                    action: decision.action,
                    reasonCode: decision.reasonCode,
                    reasoning: decision.reasoning,
                    iteration: goal.iteration ?? 0,
                };
        }
    }

    /** Create the iteration Task, dispatch it, and log both halves. */
    private async applyDispatch(
        goal: Goal,
        decision: GoalLoopDecision,
    ): Promise<GoalAdvanceResult> {
        const agentId = decision.agentId as string;
        const iteration = decision.nextIteration ?? (goal.iteration ?? 0) + 1;

        if (!this.tasksService || !this.transitions) {
            // Loud degradation: report the refusal rather than counting a
            // dispatch that never happened.
            await this.recordEvent(goal, {
                kind: 'limit',
                message:
                    'Cannot dispatch an iteration — the Tasks runtime is not available on this ' +
                    'install. Loop left running; no work was started.',
                iteration,
            });
            return {
                goalId: goal.id,
                action: 'noop',
                reasonCode: 'tasks-runtime-unavailable',
                reasoning: 'Tasks runtime unavailable',
                iteration: goal.iteration ?? 0,
            };
        }

        // The routing decision is logged BEFORE the dispatch, so a
        // dispatch that then fails still leaves the reasoning behind.
        await this.recordEvent(goal, {
            kind: 'route',
            message: decision.reasoning,
            agentId,
            iteration,
            metadata: { reasonCode: decision.reasonCode },
        });

        const task = await this.tasksService.create(
            goal.userId,
            {
                title: `[Goal] ${goal.title} — iteration ${iteration}`,
                description: this.buildIterationBrief(goal, iteration),
                status: TaskStatus.TODO,
                priority: TaskPriority.P2,
                labels: [GOAL_ITERATION_LABEL],
                goalId: goal.id,
                agentId,
                createdByType: 'user',
                createdById: goal.userId,
            },
            ownershipScopeOf(goal),
        );

        const dispatch = await this.transitions.dispatchAgentRun(task, agentId, {
            // Keyed on the iteration, so a double tick of the cron cannot
            // fire the same iteration twice.
            dedupKey: `goal:${goal.id}:${iteration}`,
        });

        goal.iteration = iteration;
        goal.activeAgentId = agentId;
        const saved = await this.goals.save(goal);

        await this.recordEvent(saved, {
            kind: 'dispatch',
            message:
                `Dispatched iteration ${iteration} — session task ${task.slug} created for agent ` +
                `${agentId}${dispatch.dispatched ? '' : ' (queued — the runtime has not started it yet)'}.`,
            agentId,
            taskId: task.id,
            iteration,
            metadata: {
                runId: dispatch.runId,
                dispatched: dispatch.dispatched,
                parked: dispatch.parked,
                executionTarget: saved.executionTarget ?? null,
                ...(dispatch.error ? { error: dispatch.error } : {}),
            },
        });
        await this.recordActivity(
            saved,
            ActivityActionType.GOAL_ITERATION_DISPATCHED,
            'iteration',
            {
                iteration,
                agentId,
                taskId: task.id,
                runId: dispatch.runId,
                reasonCode: decision.reasonCode,
            },
        );

        return {
            goalId: saved.id,
            action: 'dispatch',
            reasonCode: decision.reasonCode,
            reasoning: decision.reasoning,
            agentId,
            taskId: task.id,
            runId: dispatch.runId,
            iteration,
        };
    }

    /** Apply a terminal decision (done / paused / stuck) + log it. */
    private async applyTerminal(
        goal: Goal,
        decision: GoalLoopDecision,
        loopStatus: GoalLoopStatus,
    ): Promise<GoalAdvanceResult> {
        goal.loopStatus = loopStatus;
        goal.activeAgentId = null;
        const saved = await this.goals.save(goal);

        const kind: GoalEventKind = loopStatus === 'done' ? 'complete' : 'limit';
        await this.recordEvent(saved, {
            kind,
            message: decision.reasoning,
            metadata: { reasonCode: decision.reasonCode, spentCents: saved.spentCents },
        });
        await this.recordActivity(
            saved,
            loopStatus === 'done'
                ? ActivityActionType.GOAL_LOOP_COMPLETED
                : ActivityActionType.GOAL_LIMIT_TRIPPED,
            loopStatus,
            { reasonCode: decision.reasonCode, iteration: saved.iteration },
        );
        // A loop that stopped on a ceiling or gave up is a decision the
        // operator owes; a loop that finished is news they want.
        await this.notifyLoopStopped(saved, loopStatus, decision.reasoning);

        return {
            goalId: saved.id,
            action: decision.action,
            reasonCode: decision.reasonCode,
            reasoning: decision.reasoning,
            iteration: saved.iteration ?? 0,
        };
    }

    // ─── internals ──────────────────────────────────────────────────

    private async findOrThrow(
        userId: string,
        goalId: string,
        scope?: OwnershipScope,
    ): Promise<Goal> {
        const row = await this.goals.findOne({
            where: ownershipWhereWith<Goal>(userId, scope, { id: goalId }),
        });
        if (!row) {
            throw new NotFoundException(`Goal not found`);
        }
        return row;
    }

    /** Iteration Tasks + their latest runs, in one place. */
    private async loadGoalWork(
        goalId: string,
    ): Promise<{ tasks: Task[]; runsByTask: Map<string, AgentRun>; runs: AgentRun[] }> {
        const tasks = await this.tasks.find({
            where: { goalId },
            order: { createdAt: 'ASC' },
            take: MAX_GOAL_TASKS,
        });
        if (tasks.length === 0) {
            return { tasks, runsByTask: new Map(), runs: [] };
        }
        const runs = await this.runs.find({
            where: { taskId: In(tasks.map((task) => task.id)) },
            order: { startedAt: 'ASC' },
        });
        const runsByTask = new Map<string, AgentRun>();
        for (const run of runs) {
            if (run.taskId) runsByTask.set(run.taskId, run);
        }
        return { tasks, runsByTask, runs };
    }

    private async computeSpend(goalId: string): Promise<number> {
        const { runs } = await this.loadGoalWork(goalId);
        return runs.reduce((total, run) => total + Math.max(0, run.costCents ?? 0), 0);
    }

    private async findActiveRun(goalId: string): Promise<AgentRun | null> {
        const { runs } = await this.loadGoalWork(goalId);
        return runs.find((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null;
    }

    /**
     * Cancel the Goal's in-flight run the SAME way `POST
     * /api/agents/:id/runs/:runId/cancel` does — all three halves, in the
     * same order:
     *
     *  1. the repository CAS (authoritative; `found` alone is not enough,
     *     because an already-terminal run also reports `found`),
     *  2. the REMOTE cancel through `AGENT_RUN_CANCELLER`. Without it the
     *     Trigger.dev job keeps executing to completion after the row says
     *     `cancelled` — burning tokens the CAS-guarded `markCompleted` can
     *     no longer record, so the very spend `spendCapCents` bounds goes
     *     unmeasured. DB first, then remote, for the reason the agents
     *     controller documents: the reverse order can leave a cancelled
     *     remote run behind a row still reading `running`, and there is no
     *     agent_runs sweeper to reap it.
     *  3. draining the concurrency gate for the Work whose slot just freed,
     *     or a parked run for that Work stays parked with nothing left to
     *     release it.
     *
     * @returns the cancelled run id, or `null` when nothing was in flight
     *          (or the run had already gone terminal).
     */
    private async cancelActiveRun(goal: Goal, userId: string): Promise<string | null> {
        const active = await this.findActiveRun(goal.id);
        if (!active) return null;
        if (!this.agentRuns) {
            throw new BadRequestException(
                'Run cancellation is not available on this install — cannot restart or cancel the session.',
            );
        }
        const result = await this.agentRuns.cancel(active.id, userId);
        const wasOpen =
            result.found && ACTIVE_RUN_STATUSES.includes(result.previousStatus as string);
        if (!wasOpen) return null;

        if (result.triggerRunId && this.runCanceller) {
            // Best-effort by contract (the port must not throw), but awaited
            // so a cancel that reports success has actually asked the runtime
            // to stop. A non-'cancelled' outcome is logged with both ids so a
            // wall of 'not-configured' is distinguishable from the benign
            // already-terminal race.
            const outcome = await this.runCanceller
                .cancel(result.triggerRunId)
                .catch(() => 'failed' as const);
            if (outcome !== 'cancelled') {
                this.logger.warn(
                    `Goal ${goal.id}: run ${active.id} cancelled in the database, but the remote ` +
                        `cancel of ${result.triggerRunId} returned '${outcome}'.`,
                );
            }
        }
        if (result.workId && this.dispatchGate) {
            void this.dispatchGate.drainForWork(result.workId).catch(() => undefined);
        }
        return active.id;
    }

    /**
     * Who may run the next iteration.
     *
     * The operator pin WINS outright — an explicit rule beats a heuristic,
     * and the reasoning string says so. Otherwise the pool is every agent
     * that has already worked an iteration of this Goal, oldest first, so
     * the round-robin order is stable and reproducible from the persisted
     * data alone. An agent that has been deleted (or belongs to someone
     * else) is dropped: routing must never offer what dispatch would
     * reject.
     */
    private async resolveCandidates(goal: Goal): Promise<GoalRoutingCandidate[]> {
        if (goal.assignedAgentId) {
            const goalScope = ownershipRelationScopeOf(goal);
            const agent = this.agents
                ? await this.agents
                      .findByIdAndUser(goal.assignedAgentId, goal.userId, goalScope)
                      .catch(() => null)
                : null;
            // With no Agent repository wired we cannot verify the pin, but
            // refusing to route because of that would break the loop on a
            // slim install — the dispatch path validates ownership anyway.
            if (agent || !this.agents) {
                return [
                    {
                        agentId: goal.assignedAgentId,
                        name: agent?.name ?? agent?.slug ?? null,
                        source: 'assigned',
                    },
                ];
            }
        }

        const { tasks } = await this.loadGoalWork(goal.id);
        const out = new Map<string, GoalRoutingCandidate>();
        for (const task of tasks) {
            if (!task.agentId || out.has(task.agentId)) continue;
            const goalScope = ownershipRelationScopeOf(goal);
            const agent = this.agents
                ? await this.agents
                      .findByIdAndUser(task.agentId, goal.userId, goalScope)
                      .catch(() => null)
                : null;
            if (this.agents && !agent) continue;
            out.set(task.agentId, {
                agentId: task.agentId,
                name: agent?.name ?? agent?.slug ?? null,
                source: 'history',
            });
        }
        return [...out.values()];
    }

    /**
     * The brief handed to the routed agent. Deliberately built from
     * PERSISTED state only (open criteria, limits, model hints) so what
     * the agent is told and what the operator sees on the DoD tab cannot
     * diverge.
     */
    private buildIterationBrief(goal: Goal, iteration: number): string {
        const summary = summarizeDoD(goal.dodCriteria);
        const open = (goal.dodCriteria ?? [])
            .filter((entry) => entry.proposed !== true && entry.status === 'open')
            .map((entry) => `- [ ] ${entry.text}`);

        const lines = [
            `Iteration ${iteration} of the Goal "${goal.title}".`,
            '',
            goal.description ? `${goal.description}\n` : '',
            `Definition of Done — ${summary.done} done, ${summary.waived} waived, ${summary.open} open:`,
            open.length > 0 ? open.join('\n') : '- (no open criteria recorded)',
            '',
            'Work only on the open criteria above. When one is satisfied, say so explicitly in your',
            'summary along with the evidence, so the operator can tick it off.',
        ];

        if (goal.sessionBudgetMinutes) {
            lines.push('', `Session budget: about ${goal.sessionBudgetMinutes} minutes.`);
        }
        if (goal.workerModelHint) {
            lines.push(`Preferred model: ${goal.workerModelHint}.`);
        }
        if (goal.executionTarget) {
            lines.push(`Preferred execution target: ${goal.executionTarget}.`);
        }
        return lines.filter((line) => line !== undefined).join('\n');
    }

    /** `[Goal] … — iteration 4` → 4. Null for a hand-filed Task. */
    private iterationFromTitle(title: string): number | null {
        const match = /iteration\s+(\d+)\s*$/i.exec(title);
        return match ? Number(match[1]) : null;
    }

    /**
     * Stamp `lastProgressIteration` when the DoD rollup actually moved.
     * Stuck detection reads the gap between it and `iteration`, so a
     * checklist edit that changes nothing must NOT reset the clock.
     */
    private markProgressIfChanged(goal: Goal, beforeSignature: string): void {
        if (dodProgressSignature(goal.dodCriteria) !== beforeSignature) {
            goal.lastProgressIteration = goal.iteration ?? 0;
        }
    }

    private assertDod(criteria: unknown): void {
        const errors = validateDoDCriteria(criteria);
        if (errors.length > 0) {
            throw new BadRequestException(
                errors.map((error) => `${error.field}: ${error.message}`).join('; '),
            );
        }
    }

    private assertBoundedInt(
        value: number | null,
        field: string,
        min: number,
        max: number,
    ): number | null {
        if (value === null) return null;
        if (!Number.isInteger(value)) {
            throw new BadRequestException(`${field} must be an integer.`);
        }
        if (value < min || value > max) {
            throw new BadRequestException(`${field} must be between ${min} and ${max}.`);
        }
        return value;
    }

    private assertExecutionTarget(value: GoalExecutionTarget | null): GoalExecutionTarget | null {
        if (value === null) return null;
        if (!GOAL_EXECUTION_TARGETS.includes(value)) {
            throw new BadRequestException(
                `executionTarget must be one of ${GOAL_EXECUTION_TARGETS.join(', ')}.`,
            );
        }
        return value;
    }

    private normalizeHint(value: string | null): string | null {
        if (value === null) return null;
        const trimmed = String(value).trim();
        return trimmed.length === 0 ? null : trimmed.slice(0, MAX_MODEL_HINT_CHARS);
    }

    private async resolveAssignedAgentId(
        userId: string,
        agentId: string | null,
        scope?: OwnershipScope,
    ): Promise<string | null> {
        if (agentId === null) return null;
        if (this.agents) {
            const agent = await this.agents
                .findByIdAndUser(agentId, userId, scope)
                .catch(() => null);
            if (!agent) {
                throw new NotFoundException(`Agent ${agentId} not found.`);
            }
        }
        return agentId;
    }

    private limitsSnapshot(goal: Goal): Record<string, unknown> {
        return {
            spendCapCents: goal.spendCapCents ?? null,
            wallClockLimitHours: goal.wallClockLimitHours ?? null,
            stuckThresholdIterations: goal.stuckThresholdIterations ?? null,
            sessionBudgetMinutes: goal.sessionBudgetMinutes ?? null,
            gracePeriodMinutes: goal.gracePeriodMinutes ?? null,
            executionTarget: goal.executionTarget ?? null,
            plannerModelHint: goal.plannerModelHint ?? null,
            workerModelHint: goal.workerModelHint ?? null,
            assignedAgentId: goal.assignedAgentId ?? null,
        };
    }

    private describeLimitChange(
        before: Record<string, unknown>,
        after: Record<string, unknown>,
    ): string {
        const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
        if (changed.length === 0) {
            return 'Limits saved with no change.';
        }
        const parts = changed.map((key) => {
            const format = (value: unknown) =>
                value === null
                    ? 'none'
                    : key === 'spendCapCents'
                      ? formatUsd(Number(value))
                      : String(value);
            return `${key} ${format(before[key])} → ${format(after[key])}`;
        });
        return `Limits adjusted: ${parts.join('; ')}.`;
    }

    /** Best-effort append to the orchestrator log — never fails the op. */
    private async recordEvent(
        goal: Goal,
        entry: {
            kind: GoalEventKind;
            message: string;
            agentId?: string | null;
            taskId?: string | null;
            iteration?: number;
            metadata?: Record<string, unknown> | null;
        },
    ): Promise<void> {
        try {
            await this.events.insert({
                goalId: goal.id,
                userId: goal.userId,
                kind: entry.kind,
                message: entry.message,
                agentId: entry.agentId ?? null,
                taskId: entry.taskId ?? null,
                iteration: entry.iteration ?? goal.iteration ?? 0,
                metadata: entry.metadata ?? null,
                tenantId: goal.tenantId ?? null,
                organizationId: goal.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to write goal event (${entry.kind}) for ${goal.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** Best-effort activity write (the MissionsService idiom). */
    private async recordActivity(
        goal: Goal,
        actionType: ActivityActionType,
        action: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: goal.userId,
                actionType,
                action,
                status: ActivityStatus.COMPLETED,
                summary: `Goal ${action}`,
                details: { goalId: goal.id, ...details } as Record<string, any>,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to write goal activity (${actionType}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async notifyLoopStopped(
        goal: Goal,
        loopStatus: GoalLoopStatus,
        reasoning: string,
    ): Promise<void> {
        if (!this.notifications) return;
        try {
            await this.notifications.create({
                userId: goal.userId,
                type: loopStatus === 'done' ? NotificationType.INFO : NotificationType.WARNING,
                category: NotificationCategory.AGENT,
                title:
                    loopStatus === 'done'
                        ? `Goal "${goal.title}" is done`
                        : `Goal "${goal.title}" stopped`,
                message: reasoning,
                actionUrl: `/goals/${goal.id}`,
                actionLabel: 'Open Goal',
                isPersistent: loopStatus !== 'done',
                // One notification per (goal, stop reason, iteration), so a
                // loop that keeps re-tripping the same ceiling cannot spam.
                deduplicationKey: `goal_loop_${loopStatus}_${goal.id}_${goal.iteration ?? 0}`,
                metadata: { goalId: goal.id, loopStatus, iteration: goal.iteration ?? 0 },
            });
        } catch (error) {
            this.logger.warn(
                `Failed to notify goal loop stop for ${goal.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async notifyProposal(goal: Goal, count: number): Promise<void> {
        if (!this.notifications) return;
        try {
            await this.notifications.create({
                userId: goal.userId,
                type: NotificationType.INFO,
                category: NotificationCategory.AGENT,
                title: 'Definition of Done needs your approval',
                message: `A planning run proposed ${count} criteria for "${goal.title}".`,
                actionUrl: `/goals/${goal.id}`,
                actionLabel: 'Review',
                isPersistent: true,
                deduplicationKey: `goal_dod_proposal_${goal.id}`,
                metadata: { goalId: goal.id, proposed: count },
            });
        } catch (error) {
            this.logger.warn(
                `Failed to notify DoD proposal for ${goal.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

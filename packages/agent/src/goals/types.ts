import type {
    Goal,
    GoalComparator,
    GoalConstraint,
    GoalCriterion,
    GoalDoDCriterion,
    GoalExecutionTarget,
    GoalLoopStatus,
    GoalMetricSource,
    GoalOutcome,
    GoalResolvedScore,
    GoalStatus,
    GoalWindow,
} from '../entities/goal.entity';
import type { GoalEvent, GoalEventKind } from '../entities/goal-event.entity';
import type { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import type { MissionGoal } from '../entities/mission-goal.entity';
import { summarizeDoD, type GoalDoDSummary } from './goal-dod';

/**
 * Spec FR-12: per-Goal evaluation frequency is clamped to a minimum
 * of 15 minutes regardless of configuration. Lives here (leaf module)
 * so both GoalsService (write-path clamp) and GoalEvaluationService
 * (advance-path re-clamp) can import it without a service-file cycle.
 */
export const MIN_CHECK_FREQUENCY_MINUTES = 15;
export const DEFAULT_CHECK_FREQUENCY_MINUTES = 60;

/**
 * Goals & Metrics — PR-8. Wire-format DTOs for the Goals surface
 * (`GET/POST /api/me/goals`, mission link endpoints). Mirrors the
 * `MissionDto` idiom: plain projections of the entities, `Date`
 * instances kept as-is for the API layer to serialize, no TypeORM
 * internals leaked.
 */
export interface GoalDto {
    id: string;
    tenantId: string | null;
    organizationId: string | null;
    title: string;
    description: string | null;
    metricSource: GoalMetricSource;
    comparator: GoalComparator;
    targetValue: number;
    unit: string;
    window: GoalWindow;
    baselineValue: number | null;
    currentValue: number | null;
    currentValueAt: Date | null;
    deadline: Date | null;
    checkFrequencyMinutes: number;
    nextCheckAt: Date | null;
    status: GoalStatus;
    outcome: GoalOutcome | null;
    // Judgment layer G1 - additive. `null` on every single-metric Goal,
    // which is what an existing client already renders (absent field ->
    // absent section), so widening the DTO breaks nothing.
    criteria: GoalCriterion[] | null;
    constraints: GoalConstraint[] | null;
    resolvedScore: GoalResolvedScore | null;
    // Autonomy layer - Definition of Done, budgets/limits, loop state.
    // `null` / 0 on every Goal that never opted into the loop, which is
    // what an existing client already renders (absent section).
    dodCriteria: GoalDoDCriterion[] | null;
    /** Derived rollup so every surface renders the same "N done · N waived · N open". */
    dodSummary: GoalDoDSummary;
    spendCapCents: number | null;
    spentCents: number;
    wallClockLimitHours: number | null;
    stuckThresholdIterations: number | null;
    sessionBudgetMinutes: number | null;
    gracePeriodMinutes: number | null;
    executionTarget: GoalExecutionTarget | null;
    plannerModelHint: string | null;
    workerModelHint: string | null;
    iteration: number;
    lastProgressIteration: number;
    activeAgentId: string | null;
    assignedAgentId: string | null;
    loopStatus: GoalLoopStatus | null;
    loopStartedAt: Date | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export function toGoalDto(goal: Goal): GoalDto {
    return {
        id: goal.id,
        tenantId: goal.tenantId ?? null,
        organizationId: goal.organizationId ?? null,
        title: goal.title,
        description: goal.description ?? null,
        metricSource: goal.metricSource,
        comparator: goal.comparator,
        targetValue: goal.targetValue,
        unit: goal.unit,
        window: goal.window,
        baselineValue: goal.baselineValue ?? null,
        currentValue: goal.currentValue ?? null,
        currentValueAt: goal.currentValueAt ?? null,
        deadline: goal.deadline ?? null,
        checkFrequencyMinutes: goal.checkFrequencyMinutes,
        nextCheckAt: goal.nextCheckAt ?? null,
        status: goal.status,
        outcome: goal.outcome ?? null,
        criteria: goal.criteria ?? null,
        constraints: goal.constraints ?? null,
        resolvedScore: goal.resolvedScore ?? null,
        dodCriteria: goal.dodCriteria ?? null,
        dodSummary: summarizeDoD(goal.dodCriteria),
        spendCapCents: goal.spendCapCents ?? null,
        spentCents: goal.spentCents ?? 0,
        wallClockLimitHours: goal.wallClockLimitHours ?? null,
        stuckThresholdIterations: goal.stuckThresholdIterations ?? null,
        sessionBudgetMinutes: goal.sessionBudgetMinutes ?? null,
        gracePeriodMinutes: goal.gracePeriodMinutes ?? null,
        executionTarget: goal.executionTarget ?? null,
        plannerModelHint: goal.plannerModelHint ?? null,
        workerModelHint: goal.workerModelHint ?? null,
        iteration: goal.iteration ?? 0,
        lastProgressIteration: goal.lastProgressIteration ?? 0,
        activeAgentId: goal.activeAgentId ?? null,
        assignedAgentId: goal.assignedAgentId ?? null,
        loopStatus: goal.loopStatus ?? null,
        loopStartedAt: goal.loopStartedAt ?? null,
        archivedAt: goal.archivedAt ?? null,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
    };
}

/** One append-only observation row (progress history). */
export interface GoalMetricSampleDto {
    id: string;
    goalId: string;
    sampledAt: Date;
    value: number;
    createdAt: Date;
}

export function toGoalMetricSampleDto(sample: GoalMetricSample): GoalMetricSampleDto {
    return {
        id: sample.id,
        goalId: sample.goalId,
        sampledAt: sample.sampledAt,
        value: sample.value,
        createdAt: sample.createdAt,
    };
}

/** Mission ↔ Goal edge, expanded with the Goal projection. */
export interface MissionGoalLinkDto {
    id: string;
    missionId: string;
    goalId: string;
    isPrimary: boolean;
    createdAt: Date;
    goal: GoalDto | null;
}

export function toMissionGoalLinkDto(link: MissionGoal, goal?: Goal | null): MissionGoalLinkDto {
    const resolved = goal ?? link.goal ?? null;
    return {
        id: link.id,
        missionId: link.missionId,
        goalId: link.goalId,
        isPrimary: link.isPrimary,
        createdAt: link.createdAt,
        goal: resolved ? toGoalDto(resolved) : null,
    };
}

/**
 * Input shape for `GoalsService.create`. Validation of primitive
 * shapes lives at the DTO layer (`CreateGoalDto` in apps/api);
 * the service re-validates the semantic rules (comparator/window
 * membership, metricSource shape, ≥15-minute clamp) as the single
 * source of truth.
 */
export interface CreateGoalInput {
    title: string;
    description?: string | null;
    metricSource: GoalMetricSource;
    comparator: GoalComparator;
    targetValue: number;
    unit: string;
    window: GoalWindow;
    baselineValue?: number | null;
    deadline?: Date | null;
    checkFrequencyMinutes?: number;
    /** Judgment layer G1 - weighted criteria. Omitted = single-metric Goal. */
    criteria?: GoalCriterion[] | null;
    /** Judgment layer G1 - constraints that must hold. */
    constraints?: GoalConstraint[] | null;
}

/**
 * Input shape for `GoalsService.update`. All fields optional —
 * undefined leaves the existing value alone; `null` on nullable
 * fields explicitly clears them. `outcome` is human-overridable at
 * any time (spec FR-13), including clearing an auto-set outcome.
 */
export interface UpdateGoalInput {
    title?: string;
    description?: string | null;
    metricSource?: GoalMetricSource;
    comparator?: GoalComparator;
    targetValue?: number;
    unit?: string;
    window?: GoalWindow;
    baselineValue?: number | null;
    deadline?: Date | null;
    checkFrequencyMinutes?: number;
    outcome?: GoalOutcome | null;
    /** `null` explicitly clears the weighted path (back to single-metric). */
    criteria?: GoalCriterion[] | null;
    constraints?: GoalConstraint[] | null;
}

export interface ListGoalsFilter {
    status?: GoalStatus;
    limit?: number;
    offset?: number;
    /**
     * Archive view. Omitted = only NON-archived Goals, so the default
     * catalog quietly loses nothing but stops showing retired work;
     * `true` = only archived; `'all'` = both.
     */
    archived?: boolean | 'all';
}

// ─── Autonomy layer — limits, DoD, loop control ─────────────────────

/**
 * Input for `GoalsService.updateLimits`. Every field is optional;
 * `null` explicitly clears a ceiling (back to "uncapped"), which is
 * distinct from omitting it (leave as-is). That distinction is the whole
 * point of a live "Adjust limits" surface: an operator must be able to
 * REMOVE a cap, not just raise it.
 */
export interface UpdateGoalLimitsInput {
    spendCapCents?: number | null;
    wallClockLimitHours?: number | null;
    stuckThresholdIterations?: number | null;
    sessionBudgetMinutes?: number | null;
    gracePeriodMinutes?: number | null;
    executionTarget?: GoalExecutionTarget | null;
    plannerModelHint?: string | null;
    workerModelHint?: string | null;
    assignedAgentId?: string | null;
}

/** Per-criterion patch for `PATCH /me/goals/:id/dod/:criterionId`. */
export interface PatchGoalDoDCriterionInput {
    status?: GoalDoDStatusInput;
    text?: string;
    evidence?: string | null;
    note?: string | null;
}

/** Narrower alias so the API layer and the service agree on the union. */
export type GoalDoDStatusInput = 'open' | 'done' | 'waived';

/** One line of the orchestrator log, as served to clients. */
export interface GoalEventDto {
    id: string;
    goalId: string;
    kind: GoalEventKind;
    message: string;
    agentId: string | null;
    taskId: string | null;
    iteration: number;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
}

export function toGoalEventDto(event: GoalEvent): GoalEventDto {
    return {
        id: event.id,
        goalId: event.goalId,
        kind: event.kind,
        message: event.message,
        agentId: event.agentId ?? null,
        taskId: event.taskId ?? null,
        iteration: event.iteration ?? 0,
        metadata: event.metadata ?? null,
        createdAt: event.createdAt,
    };
}

/**
 * One row of the Goal's Sessions tab: an iteration Task paired with the
 * most recent agent run dispatched for it. Both halves are present
 * because a Task with no run yet (queued, or dispatch refused) still has
 * to be visible — hiding it would make a stalled loop look idle.
 */
export interface GoalSessionDto {
    taskId: string;
    taskSlug: string;
    taskTitle: string;
    taskStatus: string;
    iteration: number | null;
    agentId: string | null;
    runId: string | null;
    runStatus: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    durationMs: number | null;
    costCents: number | null;
    summary: string | null;
}

/** Outcome of one orchestrator advance (manual or cron). */
export interface GoalAdvanceResult {
    goalId: string;
    action: 'dispatch' | 'complete' | 'pause' | 'stuck' | 'wait' | 'noop';
    reasonCode: string;
    reasoning: string;
    agentId?: string;
    taskId?: string;
    runId?: string | null;
    iteration: number;
}

/** Structured summary returned by `GoalOrchestratorService.advanceDue`. */
export interface GoalAdvanceSummary {
    limit: number;
    dueCount: number;
    dispatched: number;
    completed: number;
    paused: number;
    stuck: number;
    failed: number;
    results: GoalAdvanceResult[];
}

/** Per-Goal outcome line in an `evaluateDue()` dispatcher summary. */
export interface GoalEvaluationEntry {
    goalId: string;
    outcome: 'evaluated' | 'achieved' | 'missed' | 'skipped' | 'failed';
    value?: number;
    message?: string;
    /**
     * Judgment layer G1 - resolved weighted score (0..1). Present ONLY
     * for Goals that declare criteria; a single-metric Goal reports
     * `value` and no score, exactly as it always has.
     */
    score?: number;
}

/** Structured summary returned by `GoalEvaluationService.evaluateDue`. */
export interface GoalEvaluationSummary {
    limit: number;
    dueCount: number;
    evaluated: number;
    skipped: number;
    failed: number;
    entries: GoalEvaluationEntry[];
}

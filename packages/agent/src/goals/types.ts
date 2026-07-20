import type {
    Goal,
    GoalComparator,
    GoalMetricSource,
    GoalOutcome,
    GoalStatus,
    GoalWindow,
} from '../entities/goal.entity';
import type { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import type { MissionGoal } from '../entities/mission-goal.entity';

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
    createdAt: Date;
    updatedAt: Date;
}

export function toGoalDto(goal: Goal): GoalDto {
    return {
        id: goal.id,
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
}

export interface ListGoalsFilter {
    status?: GoalStatus;
    limit?: number;
    offset?: number;
}

/** Per-Goal outcome line in an `evaluateDue()` dispatcher summary. */
export interface GoalEvaluationEntry {
    goalId: string;
    outcome: 'evaluated' | 'achieved' | 'missed' | 'skipped' | 'failed';
    value?: number;
    message?: string;
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

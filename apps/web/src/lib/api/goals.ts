import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Goals & Metrics — PR-8. Web-side mirror of the agent-side
 * `GoalDto` (`packages/agent/src/goals/types.ts`). Kept in lockstep
 * manually because the API contract is what the pages consume and we
 * don't want a runtime dep on the agent package from apps/web for a
 * small DTO — same idiom as `lib/api/missions.ts`.
 *
 * Date fields (`currentValueAt`, `deadline`, `nextCheckAt`,
 * `createdAt`, `updatedAt`, sample `sampledAt`) are wire-serialized
 * as ISO strings on the API side (NestJS class-transformer default);
 * we keep them as strings until a renderer actually formats them.
 */

// Pure contract values/types shared with `'use client'` components live
// in a `server-only`-free module (`goals.shared.ts`) so forms can import
// them without pulling this server-only module into the client bundle.
// Re-exported here so existing server-side callers keep one import site.
export {
    MIN_CHECK_FREQUENCY_MINUTES,
    DEFAULT_CHECK_FREQUENCY_MINUTES,
    GOAL_DOD_STATUSES,
    GOAL_LOOP_STATUSES,
    GOAL_EXECUTION_TARGETS,
    MAX_GOAL_DOD_CRITERIA,
    MAX_DOD_TEXT_CHARS,
    MAX_DOD_EVIDENCE_CHARS,
    MAX_DOD_NOTE_CHARS,
    MAX_NUDGE_CHARS,
    type GoalStatus,
    type GoalOutcome,
    type GoalComparator,
    type GoalWindow,
    type GoalDoDStatus,
    type GoalDoDSource,
    type GoalLoopStatus,
    type GoalExecutionTarget,
    type GoalEventKind,
} from './goals.shared';
import type {
    GoalStatus,
    GoalOutcome,
    GoalComparator,
    GoalWindow,
    GoalDoDStatus,
    GoalDoDSource,
    GoalEventKind,
    GoalExecutionTarget,
    GoalLoopStatus,
} from './goals.shared';

export interface GoalMetricSource {
    pluginId: string;
    metricId: string;
    params?: Record<string, unknown>;
}

/** One Definition-of-Done criterion. */
export interface GoalDoDCriterion {
    id: string;
    text: string;
    status: GoalDoDStatus;
    evidence?: string | null;
    note?: string | null;
    source?: GoalDoDSource;
    /** Awaiting operator approval — excluded from the completion rollup. */
    proposed?: boolean;
    updatedAt?: string;
}

/** Server-computed rollup rendered as "N done · N waived · N open". */
export interface GoalDoDSummary {
    total: number;
    done: number;
    waived: number;
    open: number;
    proposed: number;
    closed: number;
    complete: boolean;
}

export interface Goal {
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
    currentValueAt: string | null;
    deadline: string | null;
    checkFrequencyMinutes: number;
    nextCheckAt: string | null;
    status: GoalStatus;
    outcome: GoalOutcome | null;
    // Autonomy layer — Definition of Done, budgets/limits, loop state.
    dodCriteria: GoalDoDCriterion[] | null;
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
    loopStartedAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** One line of the per-Goal orchestrator log. */
export interface GoalEvent {
    id: string;
    goalId: string;
    kind: GoalEventKind;
    message: string;
    agentId: string | null;
    taskId: string | null;
    iteration: number;
    metadata: Record<string, unknown> | null;
    createdAt: string;
}

/** One iteration Task with its latest agent run (Sessions tab). */
export interface GoalSession {
    taskId: string;
    taskSlug: string;
    taskTitle: string;
    taskStatus: string;
    iteration: number | null;
    agentId: string | null;
    runId: string | null;
    runStatus: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    costCents: number | null;
    summary: string | null;
}

/** Outcome of one orchestrator advance. */
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

/**
 * Body for `PATCH /me/goals/:id/limits`. `null` CLEARS a ceiling and
 * `undefined` leaves it alone — the distinction survives the wire
 * because `JSON.stringify` drops undefined keys, which is exactly the
 * semantics the API expects.
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

export interface PatchGoalDodCriterionInput {
    status?: GoalDoDStatus;
    text?: string;
    evidence?: string | null;
    note?: string | null;
}

/** One append-only observation row (progress history). */
export interface GoalMetricSample {
    id: string;
    goalId: string;
    sampledAt: string;
    value: number;
    createdAt: string;
}

/** Per-Goal outcome line returned by `POST /:id/evaluate-now`. */
export interface GoalEvaluationEntry {
    goalId: string;
    outcome: 'evaluated' | 'achieved' | 'missed' | 'skipped' | 'failed';
    value?: number;
    message?: string;
}

export interface EvaluateGoalNowResult {
    entry: GoalEvaluationEntry;
    goal: Goal;
}

export interface CreateGoalInput {
    title: string;
    description?: string | null;
    metricSource: GoalMetricSource;
    comparator: GoalComparator;
    targetValue: number;
    unit: string;
    window: GoalWindow;
    baselineValue?: number | null;
    deadline?: string | null;
    checkFrequencyMinutes?: number;
}

export interface UpdateGoalInput {
    title?: string;
    description?: string | null;
    metricSource?: GoalMetricSource;
    comparator?: GoalComparator;
    targetValue?: number;
    unit?: string;
    window?: GoalWindow;
    baselineValue?: number | null;
    deadline?: string | null;
    checkFrequencyMinutes?: number;
    outcome?: GoalOutcome | null;
}

export interface ListGoalsInput {
    status?: GoalStatus;
    limit?: number;
    offset?: number;
    /** Omitted hides archived Goals; `true` shows only them; `'all'` shows both. */
    archived?: boolean | 'all';
}

function buildListEndpoint(input?: ListGoalsInput): string {
    const params = new URLSearchParams();
    if (input?.status) params.set('status', input.status);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
    if (input?.archived !== undefined) params.set('archived', String(input.archived));
    const qs = params.toString();
    return qs ? `/me/goals?${qs}` : '/me/goals';
}

export const goalsAPI = {
    async list(input?: ListGoalsInput): Promise<Goal[]> {
        return serverFetch<Goal[]>(buildListEndpoint(input), { method: 'GET' });
    },

    async get(id: string): Promise<Goal | null> {
        try {
            return await serverFetch<Goal>(`/me/goals/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async samples(id: string, limit?: number): Promise<GoalMetricSample[]> {
        const qs = limit ? `?limit=${limit}` : '';
        return serverFetch<GoalMetricSample[]>(`/me/goals/${id}/samples${qs}`, { method: 'GET' });
    },

    async create(input: CreateGoalInput): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: '/me/goals',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(id: string, input: UpdateGoalInput): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async remove(id: string): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/me/goals/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async activate(id: string): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/activate`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async pause(id: string): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/pause`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async evaluateNow(id: string): Promise<EvaluateGoalNowResult> {
        return serverMutation<EvaluateGoalNowResult>({
            endpoint: `/me/goals/${id}/evaluate-now`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // ── Autonomy layer — DoD, limits, orchestrator loop ───────────

    async events(id: string, limit?: number): Promise<GoalEvent[]> {
        const qs = limit ? `?limit=${limit}` : '';
        return serverFetch<GoalEvent[]>(`/me/goals/${id}/events${qs}`, { method: 'GET' });
    },

    async sessions(id: string): Promise<GoalSession[]> {
        return serverFetch<GoalSession[]>(`/me/goals/${id}/sessions`, { method: 'GET' });
    },

    async updateLimits(id: string, input: UpdateGoalLimitsInput): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/limits`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async setDod(id: string, criteria: GoalDoDCriterion[] | null): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/dod`,
            data: { criteria },
            method: 'PUT',
            wrapInData: false,
        });
    },

    async patchDodCriterion(
        id: string,
        criterionId: string,
        input: PatchGoalDodCriterionInput,
    ): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/dod/${encodeURIComponent(criterionId)}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async approveDod(id: string, criterionIds?: string[]): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/dod/approve`,
            data: criterionIds && criterionIds.length > 0 ? { criterionIds } : {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async loopAction(id: string, action: 'start' | 'pause' | 'resume' | 'cancel'): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/loop/${action}`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async restartSession(id: string): Promise<GoalAdvanceResult> {
        return serverMutation<GoalAdvanceResult>({
            endpoint: `/me/goals/${id}/loop/restart`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async advance(id: string): Promise<GoalAdvanceResult> {
        return serverMutation<GoalAdvanceResult>({
            endpoint: `/me/goals/${id}/advance`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async nudge(
        id: string,
        message: string,
    ): Promise<{ goal: Goal; runId: string; queuedCount?: number }> {
        return serverMutation<{ goal: Goal; runId: string; queuedCount?: number }>({
            endpoint: `/me/goals/${id}/nudge`,
            data: { message },
            method: 'POST',
            wrapInData: false,
        });
    },

    async archive(id: string): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/archive`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async unarchive(id: string): Promise<Goal> {
        return serverMutation<Goal>({
            endpoint: `/me/goals/${id}/unarchive`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};

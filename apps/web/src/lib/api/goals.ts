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
export type GoalStatus = 'draft' | 'active' | 'paused' | 'completed';
export type GoalOutcome = 'achieved' | 'missed' | 'abandoned';
export type GoalComparator = 'gte' | 'lte';
export type GoalWindow = 'day' | 'week' | 'month' | 'total' | 'point';

/**
 * Spec FR-12: per-Goal evaluation frequency is clamped server-side to
 * a minimum of 15 minutes regardless of what the form submits. Mirror
 * of `MIN_CHECK_FREQUENCY_MINUTES` from the agent package so the form
 * can surface the hint without importing the agent barrel.
 */
export const MIN_CHECK_FREQUENCY_MINUTES = 15;
export const DEFAULT_CHECK_FREQUENCY_MINUTES = 60;

export interface GoalMetricSource {
    pluginId: string;
    metricId: string;
    params?: Record<string, unknown>;
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
    createdAt: string;
    updatedAt: string;
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
}

function buildListEndpoint(input?: ListGoalsInput): string {
    const params = new URLSearchParams();
    if (input?.status) params.set('status', input.status);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
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
};

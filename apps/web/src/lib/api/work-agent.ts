import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export type WorkAgentGoalStatus =
    | 'pending'
    | 'planning'
    | 'waiting-for-approval'
    | 'running'
    | 'completed'
    | 'canceled'
    | 'rejected'
    | 'failed';

export type WorkAgentRunStatus =
    | 'queued'
    | 'planning'
    | 'researching'
    | 'generating'
    | 'writing'
    | 'waiting-for-approval'
    | 'completed'
    | 'canceled'
    | 'failed';

export interface WorkAgentGuardrails {
    maxWorksPerRun: number;
    maxItemsPerWork: number;
    maxBudgetCentsPerRun: number;
    requireApprovalBeforeCreate: boolean;
    requireApprovalBeforeDelete: boolean;
    requireApprovalAboveBudgetCents: number;
    dryRunByDefault: boolean;
}

export interface WorkAgentPreferences {
    enabled: boolean;
    autoApproveLowImpact: boolean;
    dailySuggestionsEnabled: boolean;
    guardrails: WorkAgentGuardrails;
}

export interface WorkAgentGoal {
    id: string;
    instruction: string;
    status: WorkAgentGoalStatus;
    source: string;
    dryRun: boolean;
    guardrailsOverride?: Partial<WorkAgentGuardrails> | null;
    agentPlanSummary?: string | null;
    approvalSummary?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface WorkAgentRun {
    id: string;
    goalId: string;
    status: WorkAgentRunStatus;
    dryRun: boolean;
    progressPercent: number;
    summary: {
        worksPlanned: number;
        worksCreated: number;
        itemsPlanned: number;
        itemsCreated: number;
        approvalsRequired: number;
        estimatedRemainingSeconds?: number;
    };
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface WorkAgentRunLog {
    id: string;
    runId: string;
    level: 'info' | 'warning' | 'error';
    step: string;
    message: string;
    metadata?: Record<string, unknown> | null;
    createdAt: string;
}

export interface UpdateWorkAgentPreferencesInput extends Partial<WorkAgentGuardrails> {
    enabled?: boolean;
    autoApproveLowImpact?: boolean;
    dailySuggestionsEnabled?: boolean;
}

export interface CreateWorkAgentGoalInput extends Partial<WorkAgentGuardrails> {
    instruction: string;
    dryRun?: boolean;
}

export const workAgentAPI = {
    preferences(): Promise<WorkAgentPreferences> {
        return serverFetch<WorkAgentPreferences>('/me/work-agent/preferences', {
            method: 'GET',
        });
    },

    updatePreferences(input: UpdateWorkAgentPreferencesInput): Promise<WorkAgentPreferences> {
        return serverMutation<WorkAgentPreferences>({
            endpoint: '/me/work-agent/preferences',
            data: input,
            method: 'PUT',
            wrapInData: false,
        });
    },

    listGoals(): Promise<WorkAgentGoal[]> {
        return serverFetch<WorkAgentGoal[]>('/me/work-agent/goals', { method: 'GET' });
    },

    createGoal(
        input: CreateWorkAgentGoalInput,
    ): Promise<{ goal: WorkAgentGoal; run: WorkAgentRun }> {
        return serverMutation<{ goal: WorkAgentGoal; run: WorkAgentRun }>({
            endpoint: '/me/work-agent/goals',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    cancelGoal(id: string): Promise<WorkAgentGoal> {
        return serverMutation<WorkAgentGoal>({
            endpoint: `/me/work-agent/goals/${id}/cancel`,
            data: {},
            method: 'PATCH',
            wrapInData: false,
        });
    },

    activeRun(): Promise<WorkAgentRun | null> {
        return serverFetch<WorkAgentRun | null>('/me/work-agent/runs/active', { method: 'GET' });
    },

    runLogs(id: string): Promise<WorkAgentRunLog[]> {
        return serverFetch<WorkAgentRunLog[]>(`/me/work-agent/runs/${id}/logs`, {
            method: 'GET',
        });
    },
};

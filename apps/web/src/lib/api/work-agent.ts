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
    // Phase 1 PR D — promoted-constant overrides surfaced from the
    // API. `null` = "use platform-hardcoded default" (the consumer
    // applies its own fallback). Settings UI in Phase 4 PR L will
    // read+write these. See spec §6.2 / §6.3.
    autoGenerateCadence: string | null;
    autoGenerateBatchSize: number | null;
    autoBuildThrottlePerDay: number | null;
    missionDefaultOutstandingCap: number | null;
    /** Auto-retry policy (Phase 0 PR 0.5 / Phase 1 PR FF read path). */
    maxAutoRetries: number;
    backoffSeconds: number;
    exponentialBackoffFactor: number;
    /** Account-wide budget knobs (Phase 0 PR 0.6 / Phase 7 PR II read path).
     *  Cap is a JSON-serialized bigint string; null = no cap. */
    accountWideMonthlyCapCents: string | null;
    accountWideAllowOverage: boolean;
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
    // Phase 1 PR D — PATCH-like write semantics:
    //   omit a key       → leave existing value untouched.
    //   pass `null`      → reset to "use platform-hardcoded default".
    //   pass a value     → user override.
    autoGenerateCadence?: string | null;
    autoGenerateBatchSize?: number | null;
    autoBuildThrottlePerDay?: number | null;
    missionDefaultOutstandingCap?: number | null;
    maxAutoRetries?: number;
    backoffSeconds?: number;
    exponentialBackoffFactor?: number;
    accountWideMonthlyCapCents?: string | null;
    accountWideAllowOverage?: boolean;
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

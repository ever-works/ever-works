import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export type WorkBuildRequestStatus =
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

export interface WorkBuildRequest {
    id: string;
    instruction: string;
    status: WorkBuildRequestStatus;
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
    buildRequestId: string;
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

export interface CreateWorkBuildRequestInput extends Partial<WorkAgentGuardrails> {
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

    listBuildRequests(): Promise<WorkBuildRequest[]> {
        return serverFetch<WorkBuildRequest[]>('/me/work-agent/build-requests', { method: 'GET' });
    },

    createBuildRequest(
        input: CreateWorkBuildRequestInput,
    ): Promise<{ buildRequest: WorkBuildRequest; run: WorkAgentRun }> {
        return serverMutation<{ buildRequest: WorkBuildRequest; run: WorkAgentRun }>({
            endpoint: '/me/work-agent/build-requests',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    cancelBuildRequest(id: string): Promise<WorkBuildRequest> {
        return serverMutation<WorkBuildRequest>({
            endpoint: `/me/work-agent/build-requests/${id}/cancel`,
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

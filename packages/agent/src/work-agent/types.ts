import type {
    WorkAgentGoalSource,
    WorkAgentGoalStatus,
    WorkAgentGuardrails,
    WorkAgentRunLogLevel,
    WorkAgentRunStatus,
    WorkAgentRunSummary,
} from '../entities';

export interface UpdateWorkAgentPreferencesInput extends Partial<WorkAgentGuardrails> {
    enabled?: boolean;
    autoApproveLowImpact?: boolean;
    dailySuggestionsEnabled?: boolean;
}

export interface CreateWorkAgentGoalInput extends Partial<WorkAgentGuardrails> {
    instruction: string;
    dryRun?: boolean;
}

export interface WorkAgentPreferencesDto {
    enabled: boolean;
    autoApproveLowImpact: boolean;
    dailySuggestionsEnabled: boolean;
    guardrails: WorkAgentGuardrails;
}

export interface WorkAgentGoalDto {
    id: string;
    instruction: string;
    status: WorkAgentGoalStatus;
    source: WorkAgentGoalSource;
    dryRun: boolean;
    guardrailsOverride?: Partial<WorkAgentGuardrails> | null;
    agentPlanSummary?: string | null;
    approvalSummary?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface WorkAgentRunDto {
    id: string;
    goalId: string;
    status: WorkAgentRunStatus;
    dryRun: boolean;
    progressPercent: number;
    summary: WorkAgentRunSummary;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    error?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface WorkAgentRunLogDto {
    id: string;
    runId: string;
    level: WorkAgentRunLogLevel;
    step: string;
    message: string;
    metadata?: Record<string, unknown> | null;
    createdAt: Date;
}

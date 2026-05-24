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
    /**
     * Optional FK to the originating `WorkProposal` (Idea) when this
     * Goal was created by the build-from-Idea path (Phase 1 PR B,
     * `POST /me/work-proposals/:id/build`). Persisted on the Goal
     * so the Goal-completion handler (Phase 1 PR FF) can join back
     * to the Idea — on success calls `acceptInternal(ideaId, workId)`
     * to transition the Idea to ACCEPTED with the new Work; on
     * failure persists `failureMessage` + `failureKind` on the Idea.
     *
     * NULL for the existing direct-queue path
     * (`POST /me/work-agent/goals`). PLAN Decision A3.
     */
    ideaId?: string;
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

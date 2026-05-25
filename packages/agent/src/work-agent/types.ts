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
    /**
     * Phase 1 PR D — write path for the 4 promoted constants (Phase 0
     * PR 0.4) + 3 auto-retry knobs (Phase 0 PR 0.5) + 2 account-wide
     * budget knobs (Phase 0 PR 0.6). All optional + nullable so the
     * caller can:
     *   - omit a key → leave the existing value untouched (PATCH-like).
     *   - pass `null` for the 4 promoted-constant fields → reset to
     *     "use platform-hardcoded default" (NULL on the DB column).
     *   - pass a value → user override.
     */
    autoGenerateCadence?: string | null;
    autoGenerateBatchSize?: number | null;
    autoBuildThrottlePerDay?: number | null;
    missionDefaultOutstandingCap?: number | null;
    /** Auto-retry policy — non-nullable on the DB side (has defaults).
     *  Range bounds are validated at the DTO layer (Phase 4 PR EE). */
    maxAutoRetries?: number;
    backoffSeconds?: number;
    exponentialBackoffFactor?: number;
    /** Account-wide budget knobs (Phase 0 PR 0.6).
     *  Cap is bigint → string on the JSON boundary; null = no cap. */
    accountWideMonthlyCapCents?: string | null;
    accountWideAllowOverage?: boolean;
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
    /**
     * Phase 1 PR D — promoted-constant overrides (Phase 0 PR 0.4).
     * `null` means "inherit platform-hardcoded default" — the
     * consumer reads `value ?? <hardcoded>`. Wired consumer in PR D:
     * `autoGenerateBatchSize` flows into the proposal generator's
     * target Idea count. The other 3 are surfaced through the API
     * so settings UI can read/write them; their cron-side consumers
     * land in later phases:
     *   - autoGenerateCadence    → scheduled-rerun dispatcher filter
     *                              (deferred; cron stays daily for now)
     *   - autoBuildThrottlePerDay → Phase 1 PR FF goal-completion
     *                              throttle on auto-built Works.
     *   - missionDefaultOutstandingCap → Phase 3 PR J Mission tick
     *                              worker fallback for Mission.outstandingIdeasCap.
     */
    autoGenerateCadence: string | null;
    autoGenerateBatchSize: number | null;
    autoBuildThrottlePerDay: number | null;
    missionDefaultOutstandingCap: number | null;
    /** Auto-retry policy — Phase 0 PR 0.5 + Phase 1 PR FF read path. */
    maxAutoRetries: number;
    backoffSeconds: number;
    exponentialBackoffFactor: number;
    /** Account-wide budget knobs — Phase 0 PR 0.6 + Phase 7 PR II read path. */
    accountWideMonthlyCapCents: string | null;
    accountWideAllowOverage: boolean;
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

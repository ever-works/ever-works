import type { WorkAgentGuardrails } from '../entities/work-agent-preference.entity';
import type { WorkAgentRunLogLevel } from '../entities/work-agent-run-log.entity';
import type { WorkAgentRunStatus, WorkAgentRunSummary } from '../entities/work-agent-run.entity';
import type { WorkBuildRequestSource, WorkBuildRequestStatus } from '../entities/work-build-request.entity';
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

export interface CreateWorkBuildRequestInput extends Partial<WorkAgentGuardrails> {
    instruction: string;
    dryRun?: boolean;
    /**
     * Optional FK to the originating `WorkProposal` (Idea) when this
     * build request was created by the build-from-Idea path (Phase 1 PR B,
     * `POST /me/work-proposals/:id/build`). Persisted on the build request
     * so the build-completion handler (Phase 1 PR FF) can join back
     * to the Idea — on success calls `acceptInternal(ideaId, workId)`
     * to transition the Idea to ACCEPTED with the new Work; on
     * failure persists `failureMessage` + `failureKind` on the Idea.
     *
     * NULL for the existing direct-queue path
     * (`POST /me/work-agent/build-requests`). PLAN Decision A3.
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
     * consumer reads `value ?? <hardcoded>`. Wired consumers:
     *   - autoGenerateCadence    → scheduled-rerun dispatcher due filter.
     *   - autoGenerateBatchSize  → proposal generator target Idea count.
     *   - autoBuildThrottlePerDay → Phase 1 PR FF build-completion
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

export interface WorkBuildRequestDto {
    id: string;
    instruction: string;
    status: WorkBuildRequestStatus;
    source: WorkBuildRequestSource;
    dryRun: boolean;
    guardrailsOverride?: Partial<WorkAgentGuardrails> | null;
    agentPlanSummary?: string | null;
    approvalSummary?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface WorkAgentRunDto {
    id: string;
    buildRequestId: string;
    /** @deprecated compat mirror for one release — read buildRequestId */
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

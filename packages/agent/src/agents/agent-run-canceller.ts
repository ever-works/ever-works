/**
 * Port for cancelling the external run behind an `AgentRun`.
 *
 * Cancelling an AgentRun used to be DB-only: `AgentRunRepository.cancel`
 * flipped the row to `cancelled` and nothing stopped the Trigger.dev run, so
 * the worker kept executing to completion. (`AgentRun.triggerRunId`'s docblock
 * claimed it was "used to call `runs.cancel(...)` on user-initiated cancel",
 * but no code path ever did.)
 *
 * Declared here as an interface + injection token so `packages/agent` stays
 * free of a `@trigger.dev/sdk` runtime dependency — the same shape as
 * {@link AgentHeartbeatTrigger} and the tasks-domain dispatchers. The concrete
 * adapter lives in `@ever-works/trigger-tasks` and is bound in the API-side
 * `AgentsModule`.
 */

/**
 * Why an enum rather than a boolean: an operator needs to tell "the run was
 * already finished" (normal, expected race) from "Trigger.dev is misconfigured
 * and every cancel has silently degraded to DB-only" (a real incident). A bare
 * `false` collapses both into one indistinguishable signal.
 */
export type AgentRunCancelOutcome =
    /** Trigger.dev accepted the cancel request. */
    | 'cancelled'
    /** Trigger.dev is disabled or has no secret key — no request was attempted. */
    | 'not-configured'
    /** The request was attempted and failed, typically an unknown or already-terminal run id. */
    | 'failed';

export interface AgentRunCanceller {
    /**
     * Cancel the external run.
     *
     * @param triggerRunId the Trigger.dev `run_…` id — NOT the AgentRun UUID.
     *
     * Implementations MUST NOT throw. Cancellation is best-effort and strictly
     * secondary to the DB transition: the authoritative answer to "was it
     * cancelled?" is the repository CAS, which has already committed by the
     * time this is called. Losing a remote cancel wastes compute; throwing
     * would fail an HTTP request that has already succeeded.
     */
    cancel(triggerRunId: string): Promise<AgentRunCancelOutcome>;
}

export const AGENT_RUN_CANCELLER = 'AGENT_RUN_CANCELLER' as const;

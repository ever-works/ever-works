/**
 * Run steering (Wave 4 M5) — the port `TaskChatService` reaches for when a
 * chat message mentions an agent that ALREADY has a live run on the Task.
 *
 * Same posture as `task-dispatcher.ts` and `agent-run-post-processor.ts`:
 * the interface + token live on the consumer's side of the boundary, the
 * implementation (`RunSteeringService`, in `../agents/`) is bound to the
 * token by the api-side `@Global()` AgentsModule. That keeps the direction of
 * file imports one-way (agents → tasks-domain, never back) even though the
 * runtime call goes the other way, so neither barrel can form a cycle.
 *
 * When the token is unbound — unit tests, installs without the api layer —
 * `TaskChatService` falls back to today's behaviour (dispatch a new run) with
 * no behavioural change. Extension, not replacement.
 */

export interface RunSteerInput {
    runId: string;
    /** Acting user. Every steering write is owner-scoped AND executor-stamped. */
    userId: string;
    message: string;
}

export interface RunSteerOutcome {
    /**
     * `injected` — the message was appended to the live run's pending-input
     *   queue and the executing tool loop will pick it up between iterations.
     * `new-run` — the run was already terminal, so nothing was injected and
     *   the caller must dispatch a fresh run instead.
     */
    dispatched: 'injected' | 'new-run';
    /** The run that received the message (`injected` only). */
    runId: string;
    /** Messages waiting in the queue after this append (`injected` only). */
    queuedCount?: number;
}

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — the object form
 * of `RunSteeringService.resume`, so a tasks-domain service can ask for a
 * resume through the SAME token `TaskChatService` already steers through,
 * without importing `../agents` (which imports this file — the one-way
 * rule at the top of this doc).
 */
export interface RunResumeRequest {
    /** The terminal / parked run to resume from. Runs are immutable. */
    runId: string;
    /**
     * Acting owner. For an automated resume this MUST come from platform
     * state (the Task's own `userId`), never from a webhook body — the
     * implementation loads the run with `findByIdAndUser`, so a wrong
     * owner is indistinguishable from a missing run.
     */
    userId: string;
    message?: string | null;
    /**
     * Widen the resumable set by exactly one status: a run that finished
     * NORMALLY (`completed`). A human "Resume" never sets this — it exists
     * because CI goes red AFTER the run that pushed the branch has already
     * completed cleanly, and that run is the only conversation there is to
     * continue. `cancelled` and `failed` runs stay un-resumable either way.
     */
    allowCompleted?: boolean;
}

/**
 * How many pending reviewer rejections ONE resume replays into the new
 * run's first turn (`RunSteeringService.claimRejectionFeedback`).
 *
 * It lives on the port, not in the implementation, because the CI fix
 * loop has to reason about it from the other side of the import boundary:
 * `TaskCiAutoResumeService` writes the red build as a rejection row and
 * has to know whether that row will actually be inside the replay window
 * (rows are claimed OLDEST first, and its row is the newest). When it
 * will not be, the loop hands the same text to `resume` as its message
 * instead — otherwise a Task carrying three older unconsumed reviewer
 * findings would spend a full model run and never be told CI is red.
 */
export const MAX_REPLAYED_REJECTIONS = 3;

export interface RunResumeResult {
    /** The NEW run's id. */
    runId: string;
    resumedFromRunId: string;
    /** True when the dispatch gate parked the new run instead of enqueuing it. */
    queued: boolean;
    /** Durable reviewer rejections replayed into the new run's first input. */
    rejectionsReplayed: number;
}

export interface RunSteeringPort {
    steer(input: RunSteerInput): Promise<RunSteerOutcome>;
    /**
     * OPTIONAL on the port so the pre-existing consumers and their test
     * stubs (which only ever steer) keep compiling untouched. The bound
     * implementation always has it; a caller must check before calling and
     * treat its absence as "this install cannot resume".
     */
    resumeRun?(request: RunResumeRequest): Promise<RunResumeResult>;
}

export const RUN_STEERING_PORT = 'RUN_STEERING_PORT' as const;

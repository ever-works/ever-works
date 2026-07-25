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

export interface RunSteeringPort {
    steer(input: RunSteerInput): Promise<RunSteerOutcome>;
}

export const RUN_STEERING_PORT = 'RUN_STEERING_PORT' as const;

/**
 * Tasks feature — Phase 15.3 + 15.4. Trigger-adapter contracts.
 *
 * Keeps the agent package free of a runtime `@trigger.dev/sdk`
 * dependency. The platform's Trigger.dev wrapper supplies real
 * implementations that fan out to `agent-task-execute` and
 * `agent-chat-reply`; unit tests stub synchronous ones.
 *
 * Service code calls these via Optional() injection — when the
 * adapter isn't bound (e.g. CLI, test), the dispatch becomes a no-op
 * and the run continues without firing the side-effect.
 */

export interface AgentTaskExecuteDispatchPayload {
    agentId: string;
    userId: string;
    taskId: string;
    dedupKey: string;
    runId?: string;
}

export interface AgentChatReplyDispatchPayload {
    agentId: string;
    userId: string;
    taskId: string;
    triggeringMessageId: string;
    dedupKey: string;
    runId?: string;
}

export interface AgentTaskExecuteDispatcher {
    enqueue(payload: AgentTaskExecuteDispatchPayload): Promise<{ runId: string }>;
}

export interface AgentChatReplyDispatcher {
    enqueue(payload: AgentChatReplyDispatchPayload): Promise<{ runId: string }>;
}

export const AGENT_TASK_EXECUTE_DISPATCHER = 'AGENT_TASK_EXECUTE_DISPATCHER' as const;
export const AGENT_CHAT_REPLY_DISPATCHER = 'AGENT_CHAT_REPLY_DISPATCHER' as const;

/**
 * Streaming-terminal — the seam `TaskTransitionService` reaches for when a
 * freshly-dispatched run also wants a live interactive session.
 *
 * A PORT, not the launcher class: `TerminalSessionLauncher` lives in the
 * agents module and this file must stay a leaf (it is imported by the
 * dispatch gate). The api-side @Global() `AgentsModule` binds the token
 * with `useExisting`, the same shape as `RUN_STEERING_PORT`.
 *
 * `requirePersistent` is the whole safety property of the automatic path:
 * the implementation refuses any run not flagged persistent, so a normal
 * one-shot task run never spawns (or pays for) a terminal session.
 */
export interface TerminalSessionStartRequest {
    userId: string;
    agentId: string;
    runId: string;
    requirePersistent?: boolean;
}

export interface TerminalSessionStarter {
    startForRun(request: TerminalSessionStartRequest): Promise<{ started: boolean }>;
}

export const TERMINAL_SESSION_STARTER = 'TERMINAL_SESSION_STARTER' as const;

/**
 * Stable, user-readable marker the run-failure UI keys on. Kept as an
 * exported constant so the producer (dispatcher adapters), the consumer
 * (TaskTransitionService's failure classification), and any UI matcher
 * share one literal instead of three drifting copies.
 */
export const JOB_RUNTIME_NOT_CONFIGURED_REASON = 'job-runtime-not-configured' as const;

/**
 * Thrown by dispatcher adapters when no background job runtime is
 * usable (e.g. a local install without Trigger.dev credentials). Callers
 * match on `.name` — the FacadeError house pattern — so the check works
 * across package boundaries without instanceof identity issues. The
 * point is LOUD degradation: a run must fail with a reason a human can
 * act on, never vanish into a generic SDK stack trace.
 */
export class JobRuntimeNotConfiguredError extends Error {
    constructor(message?: string) {
        super(
            message ??
                'Background job runtime is not configured on this install — agent runs cannot execute. ' +
                    'Configure a job runtime (e.g. Trigger.dev credentials) to enable agent execution.',
        );
        this.name = 'JobRuntimeNotConfiguredError';
    }
}

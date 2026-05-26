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
}

export interface AgentChatReplyDispatchPayload {
    agentId: string;
    userId: string;
    taskId: string;
    triggeringMessageId: string;
    dedupKey: string;
}

export interface AgentTaskExecuteDispatcher {
    enqueue(payload: AgentTaskExecuteDispatchPayload): Promise<{ runId: string }>;
}

export interface AgentChatReplyDispatcher {
    enqueue(payload: AgentChatReplyDispatchPayload): Promise<{ runId: string }>;
}

export const AGENT_TASK_EXECUTE_DISPATCHER = 'AGENT_TASK_EXECUTE_DISPATCHER' as const;
export const AGENT_CHAT_REPLY_DISPATCHER = 'AGENT_CHAT_REPLY_DISPATCHER' as const;

/**
 * Named Conversations — job-runtime dispatcher contracts.
 *
 * A LEAF file: it imports no service, so the dispatch service, the api-side
 * binding and the dispatch gate can all reach it without forming a cycle —
 * the same posture as `tasks-domain/task-dispatcher.ts`.
 *
 * Keeps `@ever-works/agent` free of a runtime job-runtime SDK. The platform's
 * job-runtime package supplies the real adapters, the api-side `TasksModule`
 * binds them to these tokens, and unit tests stub synchronous ones.
 *
 * Why NEW tokens instead of widening `AGENT_CHAT_REPLY_DISPATCHER`: that
 * payload requires a `taskId` and its worker, its dedup guard and the
 * dispatch-gate drain all key on a Task. A Conversation reply has no Task.
 * Making `taskId` optional would change a contract several call sites and
 * specs already depend on, and would let a Task-chat reply be dispatched
 * without the Task its dedup guard needs. The two ports sit side by side; the
 * Task path is untouched.
 */

export interface AgentConversationReplyDispatchPayload {
    agentId: string;
    userId: string;
    conversationId: string;
    /** The person's message this reply answers. */
    triggeringMessageId: string;
    /** Idempotency key handed to the job runtime. */
    dedupKey: string;
    /** The pre-created `agent_runs` row the worker claims. */
    runId?: string;
    /**
     * Scope of the Conversation. Optional and additive — carried so an
     * adapter that routes per tenant can resolve the tenant's job runtime.
     */
    tenantId?: string | null;
    organizationId?: string | null;
}

export interface AgentConversationReplyDispatcher {
    enqueue(payload: AgentConversationReplyDispatchPayload): Promise<{ runId: string }>;
}

export const AGENT_CONVERSATION_REPLY_DISPATCHER = 'AGENT_CONVERSATION_REPLY_DISPATCHER' as const;

/**
 * Organization channel fan-out (a later phase binds it). Declared here so the
 * port surface of this module is complete and stable from its first release.
 */
export interface ConversationBroadcastDispatchPayload {
    conversationId: string;
    messageId: string;
    userId: string;
    organizationId: string;
    dedupKey: string;
}

export interface ConversationBroadcastDispatcher {
    enqueue(payload: ConversationBroadcastDispatchPayload): Promise<{ runId: string }>;
}

export const CONVERSATION_BROADCAST_DISPATCHER = 'CONVERSATION_BROADCAST_DISPATCHER' as const;

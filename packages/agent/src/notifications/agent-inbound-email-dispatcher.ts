/**
 * Notifications v2 (EW-650 / EW-670 / T25) — inbound-email dispatch
 * contracts.
 *
 * Mirrors the `task-dispatcher.ts` token pattern: the agent package
 * defines the contract + a default dispatcher implementation, but the
 * heavy downstream side-effects (Task creation, Trigger.dev enqueue)
 * are delegated to OPTIONAL injected adapters so the agent package
 * stays free of the tasks-domain + @trigger.dev/sdk dependency cycle.
 *
 * Flow (spec §5.2):
 *   inbound webhook → EmailFacade.parseInbound → AgentInboundEmailDispatcher.dispatch
 *     1. resolve recipient address → tenant address row
 *     2. resolve the inbound agent assignment (lowest priority) + its mode
 *     3. persist the inbound email_messages row
 *     4a. task-spawn mode → delegate to INBOUND_EMAIL_TASK_SPAWNER (creates a
 *         Task + enqueues agent-task-execute), or
 *     4b. conversation mode → find/create email_conversations thread, link the
 *         message, touch lastMessageAt (the chat-reply path picks it up).
 */

export interface AgentInboundEmailDispatchPayload {
    /** Plugin that received the mail (e.g. 'postmark'). */
    pluginId: string;
    providerMessageId: string;
    from: string;
    to: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    receivedAt: Date;
}

export interface AgentInboundEmailDispatchResult {
    handled: boolean;
    agentId?: string;
    mode?: 'task-spawn' | 'conversation';
    emailMessageId?: string;
    conversationId?: string;
    taskId?: string;
    reason?: string;
}

export interface AgentInboundEmailDispatcher {
    dispatch(payload: AgentInboundEmailDispatchPayload): Promise<AgentInboundEmailDispatchResult>;
}

export const AGENT_INBOUND_EMAIL_DISPATCHER = 'AGENT_INBOUND_EMAIL_DISPATCHER' as const;

/**
 * Optional adapter that creates a Task from an inbound email and
 * enqueues `agent-task-execute`. Bound by the platform layer (which has
 * the tasks-domain + Trigger.dev wrappers). When unbound, task-spawn
 * mode persists the message but does not create a Task — the dispatcher
 * returns `handled: true` with no `taskId` and logs the gap.
 */
export interface InboundEmailTaskSpawnerInput {
    agentId: string;
    userId: string;
    emailMessageId: string;
    subject: string;
    bodyText: string;
    from: string;
}

export interface InboundEmailTaskSpawner {
    spawnTaskForInboundEmail(
        input: InboundEmailTaskSpawnerInput,
    ): Promise<{ taskId: string } | null>;
}

export const INBOUND_EMAIL_TASK_SPAWNER = 'INBOUND_EMAIL_TASK_SPAWNER' as const;

/**
 * Normalize an email subject into a stable conversation thread key.
 * Strips leading Re:/Fwd: prefixes (case-insensitive, repeated) and
 * collapses whitespace so a reply chain maps to one conversation.
 */
export function deriveThreadKey(subject: string): string {
    const stripped = subject
        .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
    return (stripped || '(no subject)').slice(0, 200);
}

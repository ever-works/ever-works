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
 *     1. load the tenant address the webhook was authenticated for
 *        (`payload.recipient`) — never one re-derived from `to`
 *     2. resolve the inbound agent assignment (lowest priority) + its mode
 *     3. persist the inbound email_messages row
 *     4a. task-spawn mode → delegate to INBOUND_EMAIL_TASK_SPAWNER (creates a
 *         Task + enqueues agent-task-execute), or
 *     4b. conversation mode → find/create email_conversations thread, link the
 *         message, touch lastMessageAt (the chat-reply path picks it up).
 */

/**
 * The tenant address an inbound webhook was AUTHENTICATED for: the recipient
 * whose owner's secret (their own, or the admin/env one they inherit) verified
 * the webhook's signature. `EmailFacadeService.parseInbound` answers it as
 * `authenticatedRecipient`.
 */
export interface AgentInboundEmailRecipient {
    /** `tenant_email_addresses.id`. */
    readonly emailAddressId: string;
    /** The address's owner — the scope the signature was verified at. */
    readonly userId: string;
}

export interface AgentInboundEmailDispatchPayload {
    /** Plugin that received the mail (e.g. 'postmark'). */
    pluginId: string;
    /**
     * Where the message may go: the address the webhook was authenticated for
     * (`EmailFacadeService.parseInbound` → `authenticatedRecipient`). The
     * dispatcher routes ONLY here. `null` (no recipient is a registered
     * address of this plugin) means the message is not dispatched.
     *
     * Security: never derive the destination from `to` instead. That list is
     * the sender's to write — a tenant signing with their own per-user key
     * could otherwise name their own address where verification looks and a
     * victim's where routing looks.
     */
    recipient: AgentInboundEmailRecipient | null;
    providerMessageId: string;
    from: string;
    /** Every recipient the message names — recorded, never used for routing. */
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
    // Security: `subject`, `bodyText` and `from` originate from an inbound
    // email and are fully ATTACKER-CONTROLLED (any internet sender can reach
    // a registered inbound address). They are NOT trusted instructions.
    // Implementations of `spawnTaskForInboundEmail` that surface these values
    // to an LLM/agent prompt MUST treat them as opaque untrusted data: cap
    // their length and wrap them in clearly demarcated, non-instruction
    // delimiters (e.g. `<email-subject>…</email-subject>` /
    // `<email-body>…</email-body>`) so adversarial "ignore previous
    // instructions"-style content inside an email cannot steer the agent
    // (prompt injection).
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

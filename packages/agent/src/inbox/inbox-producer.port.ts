/**
 * Inbox (operator message center) — the producer port.
 *
 * Same posture as `tasks-domain/run-steering-port.ts` and
 * `agents/agent-run-post-processor.ts`: the interface + token live in a
 * LEAF file with zero runtime imports, the consumers
 * (`AgentEscalationService`, `AgentApprovalsService`,
 * `NotificationService`) inject it `@Optional()`, and the api-side
 * `@Global()` InboxModule binds it to `InboxService`. That keeps the
 * file-import direction one-way (inbox → agents/approvals for the
 * reply routing, never back) even though the runtime call goes the
 * other way, so no barrel can form a cycle.
 *
 * When the token is unbound — unit tests, the worker's RPC context,
 * installs without the api layer — every producer keeps today's
 * behaviour byte for byte. Extension, not replacement.
 *
 * **Every method is best-effort by contract**: the inbox mirrors other
 * records; failing to mirror must never fail the record. Callers wrap
 * invocations in try/catch and log.
 */

export interface InboxEscalationRaisedInput {
    userId: string;
    escalationId: string;
    summary: string;
    decisionNeeded: string;
    agentId?: string | null;
    runId?: string | null;
    taskId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
}

export interface InboxProposalPendingInput {
    userId: string;
    proposalId: string;
    title: string;
    actionType: string;
    riskFlags?: readonly string[];
    agentId?: string | null;
    runId?: string | null;
    organizationId?: string | null;
}

export interface InboxNoticeInput {
    title: string;
    body: string;
    agentId?: string | null;
    agentRunId?: string | null;
    taskId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
}

export interface InboxProducer {
    /** Mirror a freshly-recorded escalation as an inbox item. */
    escalationRaised(input: InboxEscalationRaisedInput): Promise<void>;
    /** Mirror a freshly-created PENDING action proposal as an inbox item. */
    proposalPending(input: InboxProposalPendingInput): Promise<void>;
    /** File a plain system notice. */
    notice(userId: string, input: InboxNoticeInput): Promise<void>;
}

export const INBOX_PRODUCER = 'INBOX_PRODUCER' as const;

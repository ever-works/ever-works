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
    /**
     * Ring the bell + fan out to the human's channels for this notice.
     * Defaults to `true` — omit it and a notice behaves exactly like
     * every other inbox item.
     *
     * Set it to `false` when the SAME event already reaches the human
     * through another producer: filing the inbox row is the point, a
     * second bell row for one event is noise. The budget-threshold path
     * is the live example — `BudgetAlertHandler` already writes an
     * in-app notification and sends the templated email for the very
     * event the inbox notice mirrors. The unread sidebar badge still
     * surfaces the row.
     */
    notify?: boolean;
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

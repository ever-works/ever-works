import type { InboxItemSourceMeta } from '@ever-works/contracts';

/**
 * Inbox (operator message center) — the producer port.
 *
 * Same posture as `tasks-domain/run-steering-port.ts` and
 * `agents/agent-run-post-processor.ts`: the interface + token live in a
 * LEAF file with zero runtime imports (the contracts import above is
 * type-only), the consumers (`AgentEscalationService`,
 * `AgentApprovalsService`, `NotificationService`, the api-side fleet
 * reconciler) inject it `@Optional()`, and the api-side `@Global()`
 * InboxModule binds it to `InboxService`. That keeps the file-import
 * direction one-way (inbox → agents/approvals for the reply routing,
 * never back) even though the runtime call goes the other way, so no
 * barrel can form a cycle.
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

/**
 * Self-build slice Q — a question a FLEET run asked the Task owner
 * (written to `.ever-works/QUESTION.md` on the node, reported in the
 * job result, consumed by the api-side reconciler).
 */
export interface InboxQuestionRaisedInput {
    userId: string;
    /**
     * The PARKED run. MUST already be terminal (`markCompleted`) and
     * flagged `awaitingInput` when this is called — see the reconciler's
     * ordering: a question filed while the run row is still `running`
     * lets a fast reply route to `RunSteeringService.steer`, which
     * appends the answer to `pendingInput` nobody on a node ever reads.
     */
    agentRunId: string;
    agentId?: string | null;
    question: string;
    context?: string | null;
    /** Fleet provenance (node, branch, Task title, PR, mount), rendered as chips. */
    sourceMeta?: InboxItemSourceMeta | null;
}

export interface InboxProducer {
    /** Mirror a freshly-recorded escalation as an inbox item. */
    escalationRaised(input: InboxEscalationRaisedInput): Promise<void>;
    /** Mirror a freshly-created PENDING action proposal as an inbox item. */
    proposalPending(input: InboxProposalPendingInput): Promise<void>;
    /** File a plain system notice. */
    notice(userId: string, input: InboxNoticeInput): Promise<void>;
    /**
     * Self-build slice Q: file a question a FLEET run asked and park that
     * run — the fleet twin of `askHuman`. Task / Work / organization links
     * are derived from the run row, never from the caller (the result the
     * node reported is untrusted data). Idempotent per run: a second call
     * while an open question exists for `agentRunId` files nothing.
     */
    questionRaised(input: InboxQuestionRaisedInput): Promise<void>;
}

export const INBOX_PRODUCER = 'INBOX_PRODUCER' as const;

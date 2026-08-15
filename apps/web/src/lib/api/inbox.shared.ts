/**
 * Inbox (operator message center) — the CLIENT-SAFE half.
 *
 * `'use client'` components need the wire shape and the reply caps, but
 * `lib/api/inbox.ts` is `server-only`. Same `*.shared.ts` split the
 * meetings / goals surfaces use: pure types + constants here, fetching
 * next door.
 *
 * The values mirror `@ever-works/contracts`'s inbox module. They are
 * duplicated rather than imported so `apps/web` needs no runtime
 * dependency on the contracts bundle for a handful of literals — the
 * same idiom `meetings.shared.ts` documents. The contracts spec pins the
 * canonical values; `inbox.shared.unit.spec.ts` pins that this copy has
 * not drifted from the caps the API actually enforces.
 */

export type InboxItemKind = 'question' | 'approval' | 'escalation' | 'notice';

export type InboxItemStatus = 'open' | 'answered' | 'archived';

export type InboxItemSourceType = 'agent-run' | 'escalation' | 'proposal' | 'system' | 'work';

/** Mirrors `INBOX_MAX_REPLY_CHARS` — the API 400s past it. */
export const INBOX_MAX_REPLY_CHARS = 8000;

/** Poll cadence for the sidebar badge, matching the notification bell. */
export const INBOX_POLL_INTERVAL_MS = 30_000;

export interface InboxItemOption {
    id: string;
    label: string;
    description?: string;
    recommended?: boolean;
}

export interface InboxItem {
    id: string;
    kind: InboxItemKind;
    title: string;
    body: string;
    options: InboxItemOption[] | null;
    sourceType: InboxItemSourceType;
    agentId: string | null;
    agentRunId: string | null;
    taskId: string | null;
    workId: string | null;
    escalationId: string | null;
    proposalId: string | null;
    status: InboxItemStatus;
    unread: boolean;
    answeredAt: string | null;
    answerText: string | null;
    answerOptionId: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * How the API routed a reply. The detail view turns this into the line
 * the human reads after pressing Send — "the agent picked it up live"
 * is a materially different outcome from "a new run is answering", and
 * pretending both are just "sent" is how trust in the surface goes.
 */
export type InboxReplyRouted =
    | 'steered'
    | 'resumed'
    | 'approved'
    | 'rejected'
    | 'escalation-resolved'
    | 'already-decided'
    | 'none';

export interface InboxReplyOutcome {
    item: InboxItem;
    routed: InboxReplyRouted;
    runId?: string;
}

/**
 * An OPEN question is the only kind that leaves a run parked, so it is
 * the only kind that earns the "the agent is waiting for your reply"
 * banner.
 */
export function isAwaitingReply(item: InboxItem): boolean {
    return item.kind === 'question' && item.status === 'open';
}

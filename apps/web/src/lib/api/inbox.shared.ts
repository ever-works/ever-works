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

export type InboxItemSourceType =
    | 'agent-run'
    | 'escalation'
    | 'proposal'
    | 'system'
    | 'work'
    | 'fleet-run';

/**
 * Self-build slice Q — where a `fleet-run` question came from. Mirrors the
 * contracts `InboxItemSourceMeta`: every field optional and nullable
 * because rows written by older producers (and every other source type)
 * carry nothing. Plain text BY CONTRACT — render as chips, never as
 * markup.
 */
export interface InboxItemSourceMeta {
    nodeId?: string | null;
    nodeName?: string | null;
    /** Task branch the run pushed (or would have pushed) its work to. */
    branch?: string | null;
    taskTitle?: string | null;
    prUrl?: string | null;
    /** Set when the model asked from a mounted repository (`.mounts/<dir>`). */
    mountDir?: string | null;
}

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
    /**
     * Fleet provenance (slice Q). OPTIONAL, not just nullable: an API
     * older than this field omits the key entirely, and the UI must keep
     * rendering those payloads as plain questions.
     */
    sourceMeta?: InboxItemSourceMeta | null;
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
    /** When a human first opened it. Optional: an older API omits the key. */
    firstViewedAt?: string | null;
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

/**
 * What happened to the WORK behind an answer (My Decisions): injected into
 * the run still going, a resumed run started or queued for a slot, the
 * restart failed (the answer stands), or nothing was waiting.
 */
export type InboxReplyRestart = 'injected' | 'resumed' | 'queued' | 'failed' | 'none';

export interface InboxReplyOutcome {
    item: InboxItem;
    routed: InboxReplyRouted;
    runId?: string;
    /** Optional: an older API omits it. */
    restart?: InboxReplyRestart;
}

// ── My Decisions — the decision view of the Inbox ─────────────────────
//
// Mirrors the contracts `InboxDecision*` types. A decision is an Inbox
// item that asks the human to decide — a question, an approval or an
// escalation — read with the context of the run, Task, escalation,
// proposal and Agent it links to.

export type InboxDecisionKind = Extract<InboxItemKind, 'question' | 'approval' | 'escalation'>;

/** Mirrors `INBOX_DECISION_KINDS`. */
export const INBOX_DECISION_KINDS: readonly InboxDecisionKind[] = [
    'question',
    'approval',
    'escalation',
];

/** Mirrors `isInboxDecisionKind`: every kind but the FYI notice asks the human to decide. */
export function isInboxDecisionKind(kind: unknown): kind is InboxDecisionKind {
    return typeof kind === 'string' && (INBOX_DECISION_KINDS as readonly string[]).includes(kind);
}

/** Mirrors `INBOX_DECISION_PAGE_SIZE` — the queue pages at 25. */
export const INBOX_DECISION_PAGE_SIZE = 25;

/** Mirrors `INBOX_DECISION_QUIET_WINDOW_DAYS`. */
export const INBOX_DECISION_QUIET_WINDOW_DAYS = 14;

/** The three tabs of the decision view, backed by the Inbox statuses. */
export type InboxDecisionTab = 'open' | 'answered' | 'archived';

export interface InboxDecisionContext {
    blocking: boolean;
    blockingReason: 'run-parked' | 'task-blocked' | null;
    confidence: number | null;
    confidenceSource: 'ai-judge' | 'heuristic' | null;
    reasonCode: string | null;
    attempted: Array<{ label: string; outcome: string; detail?: string }>;
    actionType: string | null;
    riskFlags: string[];
    agentName: string | null;
    taskId: string | null;
    taskTitle: string | null;
    taskStatus: string | null;
    missionId: string | null;
    runStatus: string | null;
    dormant: boolean;
}

export interface InboxDecision extends InboxItem {
    decision: InboxDecisionContext;
}

export interface InboxDecisionCounts {
    open: number;
    blocking: number;
    lastRaisedAt: string | null;
}

/** The URL-carried filters of the decision view. */
export interface InboxDecisionFilters {
    tab: InboxDecisionTab;
    kind?: InboxDecisionKind;
    agentId?: string;
    taskId?: string;
    missionId?: string;
    q?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Untrusted search params → filters. A malformed id is dropped rather
 * than forwarded: the API would 400 it, and a stale bookmark should show
 * the queue, not an error.
 */
export function parseDecisionFilters(
    params: Record<string, string | string[] | undefined>,
): InboxDecisionFilters {
    const tabParam = first(params.tab);
    const tab: InboxDecisionTab =
        tabParam === 'answered' || tabParam === 'archived' ? tabParam : 'open';
    const filters: InboxDecisionFilters = { tab };
    const kind = first(params.kind);
    if (kind && (INBOX_DECISION_KINDS as readonly string[]).includes(kind)) {
        filters.kind = kind as InboxDecisionKind;
    }
    for (const key of ['agentId', 'taskId', 'missionId'] as const) {
        const value = first(params[key]);
        if (value && UUID_RE.test(value)) filters[key] = value;
    }
    const q = first(params.q)?.trim();
    if (q) filters.q = q.slice(0, 200);
    return filters;
}

/** Filters (+ an optional selected id) → the `/inbox?view=decisions…` href. */
export function buildDecisionsHref(
    filters: Partial<InboxDecisionFilters>,
    selectedId?: string | null,
): string {
    const params = new URLSearchParams({ view: 'decisions' });
    if (filters.tab && filters.tab !== 'open') params.set('tab', filters.tab);
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.agentId) params.set('agentId', filters.agentId);
    if (filters.taskId) params.set('taskId', filters.taskId);
    if (filters.missionId) params.set('missionId', filters.missionId);
    if (filters.q) params.set('q', filters.q);
    if (selectedId) params.set('id', selectedId);
    return `/inbox?${params.toString()}`;
}

/** Whether any narrowing filter (beyond the tab) is active. */
export function hasDecisionFilters(filters: InboxDecisionFilters): boolean {
    return Boolean(
        filters.kind || filters.agentId || filters.taskId || filters.missionId || filters.q,
    );
}

/**
 * Mirrors the contracts `inboxDecisionNeedsReason`: rejecting an approval,
 * or answering a question against its recommendation, needs a reason.
 */
export function decisionNeedsReason(
    item: Pick<InboxItem, 'kind' | 'options'>,
    optionId: string | null | undefined,
): boolean {
    if (!optionId) return false;
    if (item.kind === 'approval') return optionId === 'reject';
    if (item.kind !== 'question') return false;
    const recommended = (item.options ?? []).find((option) => option.recommended === true);
    return recommended !== undefined && recommended.id !== optionId;
}

/** Confidence as a whole percent, or `null` for "not scored". */
export function decisionConfidencePercent(confidence: number | null | undefined): number | null {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
    return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

/**
 * Which empty state an empty OPEN queue earns:
 *   first-run — no decision was ever raised (explain what a decision is);
 *   quiet     — none raised in the quiet window (nothing needing you for
 *               two weeks is worth a second look, not a celebration);
 *   clear     — recently busy, currently drained.
 */
export function decisionEmptyState(
    lastRaisedAt: string | null | undefined,
    now: Date = new Date(),
): { kind: 'first-run' } | { kind: 'quiet'; days: number } | { kind: 'clear' } {
    if (!lastRaisedAt) return { kind: 'first-run' };
    const raised = Date.parse(lastRaisedAt);
    if (!Number.isFinite(raised)) return { kind: 'first-run' };
    const days = Math.floor((now.getTime() - raised) / (24 * 60 * 60 * 1000));
    return days >= INBOX_DECISION_QUIET_WINDOW_DAYS ? { kind: 'quiet', days } : { kind: 'clear' };
}

/**
 * The line an owner reads after answering: what happened to the work.
 * An older API without `restart` falls back to the routing verdict.
 */
export function decisionRestartKey(
    outcome: Pick<InboxReplyOutcome, 'routed' | 'restart'>,
): 'resumed' | 'injected' | 'queued' | 'failed' | 'none' | 'alreadyDecided' {
    if (outcome.routed === 'already-decided') return 'alreadyDecided';
    if (outcome.restart) return outcome.restart;
    if (outcome.routed === 'steered') return 'injected';
    if (outcome.routed === 'resumed') return 'resumed';
    return 'none';
}

/**
 * An OPEN question is the only kind that leaves a run parked, so it is
 * the only kind that earns the "the agent is waiting for your reply"
 * banner.
 */
export function isAwaitingReply(item: InboxItem): boolean {
    return item.kind === 'question' && item.status === 'open';
}

/**
 * A question a FLEET run asked (self-build slice Q) — the run executed on
 * one of the owner's own machines, wrote `.ever-works/QUESTION.md`, and
 * is parked until the reply starts a new run on the same branch. The
 * source type is the whole test: the API only ever files `fleet-run`
 * rows as questions, and `sourceMeta` is decoration, not the signal.
 */
export function isFleetQuestion(item: InboxItem): boolean {
    return item.sourceType === 'fleet-run';
}

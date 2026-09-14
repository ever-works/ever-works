import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Inbox (operator message center) — server-only client for the
 * owner-scoped `/api/inbox` surface
 * (`apps/api/src/inbox/inbox.controller.ts`).
 *
 *   GET    /api/inbox                 my messages (?status= ?taskId=) + unread count
 *   GET    /api/inbox/unread-count    the sidebar badge
 *   GET    /api/inbox/decisions       My Decisions — the decision view (ranked, filtered)
 *   GET    /api/inbox/decisions/counts open + blocking decision counts
 *   GET    /api/inbox/:id             one message
 *   POST   /api/inbox/:id/reply       answer it (routed per kind)
 *   PATCH  /api/inbox/:id/read        read / unread
 *   POST   /api/inbox/:id/archive     archive
 *   POST   /api/inbox/:id/unarchive   restore
 *   DELETE /api/inbox/:id             delete the message
 *
 * Omitting `status` asks for the ACTIVE view (open + answered); the
 * Archived tab passes `status=archived` explicitly. `taskId` narrows the
 * list to one Task's messages — the Task page uses it (self-build slice
 * Q) to find the open fleet question a parked run is waiting on, because
 * the run row itself cannot name its question.
 */

export {
    INBOX_DECISION_PAGE_SIZE,
    INBOX_MAX_REPLY_CHARS,
    INBOX_POLL_INTERVAL_MS,
    isAwaitingReply,
    isFleetQuestion,
    type InboxDecision,
    type InboxDecisionCounts,
    type InboxDecisionFilters,
    type InboxItem,
    type InboxItemKind,
    type InboxItemOption,
    type InboxItemSourceMeta,
    type InboxItemSourceType,
    type InboxItemStatus,
    type InboxReplyOutcome,
    type InboxReplyRouted,
} from './inbox.shared';
import type {
    InboxDecision,
    InboxDecisionCounts,
    InboxDecisionFilters,
    InboxItem,
    InboxItemStatus,
    InboxReplyOutcome,
} from './inbox.shared';

export interface InboxListResult {
    data: InboxItem[];
    meta: { total: number; limit: number; offset: number; unreadCount: number };
}

export interface ListInboxInput {
    /** Omitted = the active view (everything not archived). */
    status?: InboxItemStatus;
    /** The API clamps to 1–100 and defaults to 50. */
    limit?: number;
    offset?: number;
    /** Only this Task's messages (owner-scoped server-side, like everything here). */
    taskId?: string;
}

export interface ReplyInboxInput {
    text?: string;
    optionId?: string;
    /**
     * My Decisions — opt into the decision answer rule: a rejection, or an
     * option other than the recommended one, must carry `text` saying why.
     */
    requireReason?: boolean;
}

export interface InboxDecisionListResult {
    data: InboxDecision[];
    meta: {
        total: number;
        limit: number;
        offset: number;
        openCount: number;
        blockingCount: number;
        lastRaisedAt: string | null;
        /**
         * Continues right after the last row of this page; `null` when
         * nothing ranks after it. Optional: an API that predates it omits it.
         */
        nextCursor?: string | null;
    };
}

export interface ListInboxDecisionsInput extends Partial<InboxDecisionFilters> {
    /** The API refuses above 100 and defaults to 25. */
    limit?: number;
    offset?: number;
    /**
     * The previous page's `meta.nextCursor`. Prefer it to `offset` for
     * "Load more": a live queue re-ranks between reads, and an offset into
     * it skips or repeats decisions.
     */
    cursor?: string;
}

function buildDecisionsEndpoint(input?: ListInboxDecisionsInput): string {
    const params = new URLSearchParams();
    if (input?.tab) params.set('status', input.tab);
    if (input?.kind) params.set('kind', input.kind);
    if (input?.agentId) params.set('agentId', input.agentId);
    if (input?.taskId) params.set('taskId', input.taskId);
    if (input?.missionId) params.set('missionId', input.missionId);
    if (input?.q) params.set('q', input.q);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
    if (input?.cursor) params.set('cursor', input.cursor);
    const qs = params.toString();
    return qs ? `/inbox/decisions?${qs}` : '/inbox/decisions';
}

function buildListEndpoint(input?: ListInboxInput): string {
    const params = new URLSearchParams();
    if (input?.status) params.set('status', input.status);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
    if (input?.taskId) params.set('taskId', input.taskId);
    const qs = params.toString();
    return qs ? `/inbox?${qs}` : '/inbox';
}

export const inboxAPI = {
    async list(input?: ListInboxInput): Promise<InboxListResult> {
        return serverFetch<InboxListResult>(buildListEndpoint(input), { method: 'GET' });
    },

    async unreadCount(): Promise<number> {
        const result = await serverFetch<{ count: number }>('/inbox/unread-count', {
            method: 'GET',
        });
        return result?.count ?? 0;
    },

    /**
     * My Decisions — the Inbox items that need the human to decide,
     * ranked blocking-first on the open tab, plus the header counts.
     */
    async listDecisions(input?: ListInboxDecisionsInput): Promise<InboxDecisionListResult> {
        return serverFetch<InboxDecisionListResult>(buildDecisionsEndpoint(input), {
            method: 'GET',
        });
    },

    async decisionCounts(): Promise<InboxDecisionCounts> {
        return serverFetch<InboxDecisionCounts>('/inbox/decisions/counts', { method: 'GET' });
    },

    /**
     * `null` for a missing item AND for another owner's — the API 404s
     * identically in both cases, so the page turns either into "pick a
     * message" rather than leaking which ids exist.
     */
    async get(id: string): Promise<InboxItem | null> {
        try {
            return await serverFetch<InboxItem>(`/inbox/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async reply(id: string, input: ReplyInboxInput): Promise<InboxReplyOutcome> {
        return serverMutation<InboxReplyOutcome>({
            endpoint: `/inbox/${id}/reply`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async setRead(id: string, unread: boolean): Promise<InboxItem> {
        return serverMutation<InboxItem>({
            endpoint: `/inbox/${id}/read`,
            data: { unread },
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async setArchived(id: string, archived: boolean): Promise<InboxItem> {
        return serverMutation<InboxItem>({
            endpoint: `/inbox/${id}/${archived ? 'archive' : 'unarchive'}`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async remove(id: string): Promise<void> {
        await serverMutation<{ deleted: true; itemId: string }>({
            endpoint: `/inbox/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};

import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Inbox (operator message center) — server-only client for the
 * owner-scoped `/api/inbox` surface
 * (`apps/api/src/inbox/inbox.controller.ts`).
 *
 *   GET    /api/inbox                 my messages (?status=) + unread count
 *   GET    /api/inbox/unread-count    the sidebar badge
 *   GET    /api/inbox/:id             one message
 *   POST   /api/inbox/:id/reply       answer it (routed per kind)
 *   PATCH  /api/inbox/:id/read        read / unread
 *   POST   /api/inbox/:id/archive     archive
 *   POST   /api/inbox/:id/unarchive   restore
 *   DELETE /api/inbox/:id             delete the message
 *
 * Omitting `status` asks for the ACTIVE view (open + answered); the
 * Archived tab passes `status=archived` explicitly.
 */

export {
    INBOX_MAX_REPLY_CHARS,
    INBOX_POLL_INTERVAL_MS,
    isAwaitingReply,
    type InboxItem,
    type InboxItemKind,
    type InboxItemOption,
    type InboxItemSourceType,
    type InboxItemStatus,
    type InboxReplyOutcome,
    type InboxReplyRouted,
} from './inbox.shared';
import type { InboxItem, InboxItemStatus, InboxReplyOutcome } from './inbox.shared';

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
}

export interface ReplyInboxInput {
    text?: string;
    optionId?: string;
}

function buildListEndpoint(input?: ListInboxInput): string {
    const params = new URLSearchParams();
    if (input?.status) params.set('status', input.status);
    if (input?.limit) params.set('limit', String(input.limit));
    if (input?.offset && input.offset > 0) params.set('offset', String(input.offset));
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

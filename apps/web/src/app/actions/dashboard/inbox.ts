'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { inboxAPI, type ReplyInboxInput } from '@/lib/api/inbox';
import type { InboxItem, InboxReplyOutcome } from '@/lib/api/inbox.shared';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Inbox (operator message center) — server actions behind the `/inbox`
 * UI and the sidebar badge.
 *
 * Every action forwards to the JWT-protected `/api/inbox`, which is
 * owner-scoped down in the repository; the auth check here is
 * defense-in-depth so an unauthenticated caller is rejected before a
 * request is issued, matching `agent-approvals.ts`.
 */

async function requireInboxAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

const INBOX_PATH = '/[locale]/(dashboard)/inbox';

function revalidateInbox() {
    revalidatePath(INBOX_PATH, 'page');
}

export async function replyToInboxItemAction(
    id: string,
    input: ReplyInboxInput,
): Promise<InboxReplyOutcome> {
    await requireInboxAuth();
    const outcome = await inboxAPI.reply(id, input);
    revalidateInbox();
    return outcome;
}

export async function setInboxItemReadAction(id: string, unread: boolean): Promise<InboxItem> {
    await requireInboxAuth();
    const item = await inboxAPI.setRead(id, unread);
    revalidateInbox();
    return item;
}

export async function setInboxItemArchivedAction(
    id: string,
    archived: boolean,
): Promise<InboxItem> {
    await requireInboxAuth();
    const item = await inboxAPI.setArchived(id, archived);
    revalidateInbox();
    return item;
}

export async function deleteInboxItemAction(id: string): Promise<{ deleted: true }> {
    await requireInboxAuth();
    await inboxAPI.remove(id);
    revalidateInbox();
    return { deleted: true };
}

/**
 * Sidebar badge poll. Returns `null` rather than throwing when the API
 * is unhappy — a flaky count must not blank the sidebar or spam the
 * console every 30 seconds.
 */
export async function getInboxUnreadCountAction(): Promise<number | null> {
    const user = await getAuthFromCookie();
    if (!user) return null;
    try {
        return await inboxAPI.unreadCount();
    } catch {
        return null;
    }
}

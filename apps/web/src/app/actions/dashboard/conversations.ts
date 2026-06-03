'use server';

import {
    conversationsAPI,
    type ConversationSummary,
    type ConversationDetail,
} from '@/lib/api/conversations';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export async function listConversations(
    limit = 50,
    offset = 0,
): Promise<{ conversations: ConversationSummary[]; total: number }> {
    // Security: defense-in-depth auth guard at the web tier, matching the
    // pattern in the sibling dashboard actions (comparisons.ts / items.ts).
    // Without it an unauthenticated server-action POST reaches the API call;
    // redirecting to login gives consistent UX even though the API also checks.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return conversationsAPI.list(limit, offset);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return conversationsAPI.get(id);
}

export async function createConversation(
    providerId?: string,
    title?: string,
): Promise<ConversationSummary> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return conversationsAPI.create({ providerId, title });
}

export async function deleteConversation(id: string): Promise<void> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    await conversationsAPI.delete(id);
}

export async function deleteAllConversations(): Promise<{ deleted: number }> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return conversationsAPI.deleteAll();
}

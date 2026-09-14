'use server';

import {
    conversationsAPI,
    type ConversationSummary,
    type ConversationDetail,
    type CreateNamedConversationInput,
    type NamedConversationListFilters,
    type NamedConversationRow,
    type SendNamedConversationMessageInput,
} from '@/lib/api/conversations';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    isConversationFailureCode,
    type ConversationFailureCode,
    type ConversationMentionCandidate,
    type ConversationMessageView,
    type ConversationSendResult,
    type ConversationSummaryView,
} from '@ever-works/contracts';

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
    model?: string,
): Promise<ConversationSummary> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return conversationsAPI.create({ providerId, title, model });
}

/**
 * Persist the model a conversation is pinned to, so re-opening the thread
 * restores the user's choice instead of falling back to whatever the browser
 * last used. Pass `null` to clear the pin back to the provider default.
 */
export async function updateConversationModel(id: string, model: string | null): Promise<void> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    await conversationsAPI.updateModel(id, model);
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

// ── Named Conversations with an Agent ──────────────────────────────────
//
// Unlike the actions above, these RETURN their failure instead of throwing
// it. A refused send has to reach the composer with its reason — rate limit,
// credential in the text, too long, lost access — so the person sees why in
// plain language and keeps the message (FR-39, FR-46). A thrown error from a
// server action arrives in the browser with its message and status stripped.

export type ConversationActionResult<T> =
    | { ok: true; data: T }
    | {
          ok: false;
          /** HTTP status from the API; `0` when the API could not be reached. */
          status: number;
          failureCode: ConversationFailureCode | null;
          /** Extra numbers a refusal carries (`size` / `max` for a body too long). */
          details: { size?: number; max?: number };
      };

async function ensureAuth(): Promise<void> {
    // Security: defense-in-depth auth guard at the web tier (see listConversations).
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

/** Map an API failure onto the stable reason the composer explains. */
function toFailure<T>(error: unknown): ConversationActionResult<T> {
    if (error instanceof ApiResponseError) {
        const details = error.details ?? {};
        const code = details.failureCode;
        const size = typeof details.size === 'number' ? details.size : undefined;
        const max = typeof details.max === 'number' ? details.max : undefined;
        let failureCode: ConversationFailureCode | null = isConversationFailureCode(code)
            ? code
            : null;
        if (!failureCode) {
            if (error.statusCode === 429) failureCode = 'rate_limited';
            else if (error.statusCode === 403 || error.statusCode === 404)
                failureCode = 'forbidden';
            else if (error.statusCode >= 500) failureCode = 'provider_unavailable';
        }
        return { ok: false, status: error.statusCode, failureCode, details: { size, max } };
    }
    // The API was not reachable from the web tier at all.
    return { ok: false, status: 0, failureCode: 'network', details: {} };
}

async function attempt<T>(call: () => Promise<T>): Promise<ConversationActionResult<T>> {
    await ensureAuth();
    try {
        return { ok: true, data: await call() };
    } catch (error) {
        return toFailure<T>(error);
    }
}

export async function listNamedConversations(
    filters: NamedConversationListFilters,
): Promise<ConversationActionResult<{ conversations: ConversationSummaryView[]; total: number }>> {
    return attempt(() => conversationsAPI.listNamed(filters));
}

export async function createNamedConversation(
    input: CreateNamedConversationInput,
): Promise<ConversationActionResult<NamedConversationRow>> {
    return attempt(() => conversationsAPI.createNamed(input));
}

export async function setConversationName(
    id: string,
    name: string | null,
): Promise<ConversationActionResult<{ id: string; title: string | null }>> {
    return attempt(() => conversationsAPI.setName(id, name));
}

export async function listConversationMessages(
    id: string,
    options: { limit?: number; before?: string } = {},
): Promise<ConversationActionResult<{ messages: ConversationMessageView[] }>> {
    return attempt(() => conversationsAPI.listMessages(id, options));
}

export async function sendConversationMessage(
    id: string,
    input: SendNamedConversationMessageInput,
): Promise<ConversationActionResult<ConversationSendResult>> {
    return attempt(() => conversationsAPI.send(id, input));
}

export async function retryConversationMessage(
    id: string,
    messageId: string,
): Promise<ConversationActionResult<ConversationSendResult>> {
    return attempt(() => conversationsAPI.retry(id, messageId));
}

export async function discardConversationMessage(
    id: string,
    messageId: string,
): Promise<ConversationActionResult<void>> {
    return attempt(() => conversationsAPI.discard(id, messageId));
}

export async function markConversationRead(
    id: string,
    lastReadMessageId: string,
): Promise<ConversationActionResult<void>> {
    return attempt(() => conversationsAPI.markRead(id, lastReadMessageId));
}

export async function listMentionCandidates(
    query: string,
): Promise<ConversationActionResult<{ candidates: ConversationMentionCandidate[] }>> {
    return attempt(() => conversationsAPI.mentionCandidates(query.slice(0, 80)));
}

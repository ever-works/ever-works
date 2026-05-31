import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { openChatPanel } from './helpers/chat';

/**
 * AI conversation history — real persistence + in-panel history integration.
 *
 * User ask: "sending chat messages creates a conversation the user can find later."
 *
 * Verified against the LIVE conversations API (apps/api/src/ai-conversation/
 * conversation.controller.ts) as a throwaway user:
 *   - POST   /api/conversations              → returns the created row directly:
 *            { id, userId, title, providerId, model, createdAt, updatedAt, ... }
 *   - POST   /api/conversations/:id/messages → { success: true }; also back-fills
 *            the conversation title from the first user message when title is empty.
 *   - GET    /api/conversations              → { conversations: [{ id, title,
 *            providerId, model, createdAt, updatedAt }], total } (NOT a bare array).
 *   - GET    /api/conversations/:id          → conversation + messages[]:
 *            messages = [{ id, conversationId, role, content, ... }].
 *   - PATCH  /api/conversations/:id          → 204, persists the new title.
 *   - DELETE /api/conversations/:id          → 204; subsequent GET → 404.
 *
 * The persistence assertions are DRIVEN VIA THE API against the SEEDED user's
 * bearer token, so they are deterministic regardless of whether an AI provider
 * is configured (conversations exist independent of completions). The UI step
 * opens the chat panel, clicks the in-panel "History" control (ChatToolbar →
 * ChatHistory, dashboard.aiChat.history), and asserts the saved conversation
 * surfaces in the history list (the same conversation the API just created is
 * owned by the logged-in seeded user, so ChatProvider.refreshConversations —
 * which hits GET /api/conversations under the session cookie — returns it).
 */

const HISTORY_BUTTON = 'History'; // dashboard.aiChat.history
const HISTORY_HEADER = 'History'; // ChatHistory header label (same i18n key)

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), 'seeded login status').toBe(200);
    return (await res.json()).access_token;
}

interface ListShape {
    conversations: Array<{ id: string; title?: string | null; updatedAt?: string }>;
    total?: number;
}

async function listConversations(
    request: APIRequestContext,
    token: string,
): Promise<ListShape['conversations']> {
    const res = await request.get(`${API_BASE}/api/conversations?limit=100`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'list status').toBe(200);
    const body = (await res.json()) as ListShape;
    // API returns the wrapped { conversations, total } shape; tolerate a bare
    // array too in case the contract ever flattens.
    const arr = Array.isArray(body) ? body : (body?.conversations ?? []);
    expect(Array.isArray(arr), 'conversations is array').toBe(true);
    return arr;
}

test.describe('Conversation history — persistence + in-panel history', () => {
    test('a created conversation persists, lists, renames, and surfaces in the chat history panel', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const headers = authedHeaders(token);
        const suffix = Date.now().toString(36);
        const originalTitle = `e2e history convo ${suffix}`;
        const userMessage = `Persisted history probe ${suffix}`;

        // 1. Establish a conversation deterministically via the documented API.
        const createRes = await request.post(`${API_BASE}/api/conversations`, {
            headers,
            data: { title: originalTitle },
        });
        expect(createRes.status(), 'create status').toBeGreaterThanOrEqual(200);
        expect(createRes.status(), 'create status').toBeLessThan(300);
        const created = await createRes.json();
        const convoId: string = created?.id ?? created?.conversation?.id ?? created?.data?.id;
        expect(convoId, 'created conversation has id').toBeTruthy();
        expect(created.title, 'created title echoes input').toBe(originalTitle);

        // Append a user + assistant message pair (the persistence the user cares
        // about — the substance of a "conversation they can find later").
        const appendRes = await request.post(`${API_BASE}/api/conversations/${convoId}/messages`, {
            headers,
            data: {
                messages: [
                    { role: 'user', content: userMessage },
                    { role: 'assistant', content: `Acknowledged ${suffix}` },
                ],
            },
        });
        expect(appendRes.status(), 'append messages status').toBeLessThan(300);
        const appendBody = await appendRes.json().catch(() => ({}));
        expect(appendBody?.success, 'append reports success').toBe(true);

        // 2a. Persisted: GET /api/conversations contains it (by id + title).
        const list = await listConversations(request, token);
        const listed = list.find((c) => c.id === convoId);
        expect(listed, 'created conversation appears in list').toBeTruthy();
        expect(listed?.title, 'listed title matches').toBe(originalTitle);

        // 2b. Persisted: GET /api/conversations/:id returns the messages we wrote.
        const getRes = await request.get(`${API_BASE}/api/conversations/${convoId}`, { headers });
        expect(getRes.status(), 'get single status').toBe(200);
        const detail = await getRes.json();
        const messages: Array<{ role: string; content: string }> = detail?.messages ?? [];
        expect(Array.isArray(messages), 'detail has messages array').toBe(true);
        expect(
            messages.some((m) => m.role === 'user' && m.content === userMessage),
            'persisted user message round-trips',
        ).toBe(true);
        expect(
            messages.some((m) => m.role === 'assistant' && m.content === `Acknowledged ${suffix}`),
            'persisted assistant message round-trips',
        ).toBe(true);

        // 3. Rename via PATCH and assert the new title persists (list + detail).
        const renamedTitle = `e2e renamed convo ${suffix}`;
        const patchRes = await request.patch(`${API_BASE}/api/conversations/${convoId}`, {
            headers,
            data: { title: renamedTitle },
        });
        expect(patchRes.status(), 'patch status').toBeLessThan(400);

        // Title update settles async on the row's updatedAt; poll the read model.
        await expect
            .poll(
                async () => {
                    const after = await listConversations(request, token);
                    return after.find((c) => c.id === convoId)?.title ?? null;
                },
                { timeout: 15_000, message: 'renamed title persists in list' },
            )
            .toBe(renamedTitle);

        const getAfterRename = await request.get(`${API_BASE}/api/conversations/${convoId}`, {
            headers,
        });
        expect(getAfterRename.status()).toBe(200);
        expect((await getAfterRename.json())?.title, 'renamed title in detail').toBe(renamedTitle);

        // 4. UI: open the chat panel, click History, assert the saved conversation
        // (now renamed) appears in the in-panel history list. The seeded user is
        // the logged-in UI user and owns this conversation, so the session-cookie
        // GET /api/conversations behind ChatProvider.refreshConversations sees it.
        await openChatPanel(page);

        // The History control is a <button> rendering the i18n "History" label
        // (ChatToolbar.tsx). Under `next dev` the panel hydrates lazily, so retry
        // the click until the ChatHistory view (its own "History" header) shows.
        const historyButton = page.getByRole('button', { name: HISTORY_BUTTON }).first();
        await expect(historyButton).toBeVisible({ timeout: 30_000 });

        const historyTitle = page.getByText(renamedTitle, { exact: false }).first();
        await expect(async () => {
            await historyButton.click({ timeout: 5_000 }).catch(() => {});
            // In the history view the list renders each conversation's title text.
            await expect(historyTitle).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 45_000 });

        // Sanity: the history header is present (we are truly in the history view,
        // not still on the welcome/toolbar screen). historyEmpty would only show
        // when there are zero conversations — which cannot be the case here.
        await expect(page.getByText(HISTORY_HEADER, { exact: true }).first()).toBeVisible({
            timeout: 10_000,
        });

        // 5. Cleanup-ish assertion: DELETE removes it from the persisted list.
        const delRes = await request.delete(`${API_BASE}/api/conversations/${convoId}`, {
            headers,
        });
        expect(delRes.status(), 'delete status').toBeLessThan(400);
        expect([401, 403], 'delete not an auth failure').not.toContain(delRes.status());

        const afterDelete = await listConversations(request, token);
        expect(
            afterDelete.find((c) => c.id === convoId),
            'deleted conversation gone from list',
        ).toBeFalsy();

        const getGone = await request.get(`${API_BASE}/api/conversations/${convoId}`, { headers });
        expect(getGone.status(), 'get after delete → 404').toBe(404);
    });
});

import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Chat conversation lifecycle — REAL multi-step orchestration.
 *
 * Drives the AI-conversation domain end-to-end against the live API + chat
 * side-panel UI. Source of truth: apps/api/src/ai-conversation/conversation.controller.ts
 * (mounted under @Controller('api/conversations')) and the web ChatProvider /
 * ChatHistory components (apps/web/src/components/ai/).
 *
 * VERIFIED API SHAPES (probed live against http://127.0.0.1:3100 before writing):
 *   POST   /api/conversations            { title?, providerId? }
 *      → 201 { id, userId, title|null, providerId|null, model|null, metadata|null,
 *               tenantId|null, organizationId|null, createdAt, updatedAt }   (NO messages)
 *   GET    /api/conversations            → { conversations: [{ id, title, providerId,
 *               model, createdAt, updatedAt }], total }   (summaries, newest-scoped)
 *   GET    /api/conversations/:id        → full row + `messages: []` array (ASC by createdAt);
 *               404 { message:'Not Found', statusCode:404 } when missing / not owned
 *   PATCH  /api/conversations/:id        { title }  → 204 No Content (empty body); 404 if missing
 *   POST   /api/conversations/:id/messages { messages:[{ role, content, parts?, model?, usage? }] }
 *      → 201 { success:true } (NestJS @Post default — appendMessages has no @HttpCode(200)
 *        override); persists in append order; if the conversation had a
 *        NULL title the first user message becomes the title (<=60 chars, else 57+'...').
 *        404 if the conversation is missing.
 *   DELETE /api/conversations/:id        → 204; subsequent GET → 404; re-DELETE → 404
 *
 * UI: the chat side-panel toolbar (ChatToolbar) renders a "History" button even
 * with an empty transcript; clicking it swaps ChatInterface → ChatHistory, which
 * calls the `listConversations` server action (cookie-authed as the seeded user)
 * and renders each conversation's title (or "Untitled conversation"), or the
 * empty state "No conversations yet. Start a chat to see your history here."
 *
 * Cross-spec isolation: API-only flows (1 + 3) run on FRESH registered users so
 * the shared in-memory DB stays clean and assertions are exact. The UI flow (2)
 * mutates the SEEDED user (whose storageState the browser carries) so the API
 * row surfaces in that user's own history panel; it asserts toContain (tolerant
 * of pre-existing rows) and cleans up its created row afterward.
 */

const HISTORY_EMPTY = 'No conversations yet. Start a chat to see your history here.';

interface ConversationRow {
    id: string;
    userId: string;
    title: string | null;
    providerId: string | null;
    model: string | null;
    metadata: unknown;
    tenantId: string | null;
    organizationId: string | null;
    createdAt: string;
    updatedAt: string;
    messages?: ConversationMessage[];
}

interface ConversationMessage {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    parts: unknown;
    model: string | null;
    usage: unknown;
    createdAt: string;
}

interface ConversationSummary {
    id: string;
    title: string | null;
    providerId: string | null;
    model: string | null;
    createdAt: string;
    updatedAt: string;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    // LOGIN DTO is whitelisted — ONLY { email, password } (a `name` prop 400s).
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), 'seeded login').toBe(200);
    return (await res.json()).access_token;
}

async function createConversation(
    request: APIRequestContext,
    token: string,
    body: { title?: string; providerId?: string },
): Promise<ConversationRow> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), 'create conversation').toBe(201);
    return res.json();
}

async function getConversation(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<{ status: number; row: ConversationRow | null }> {
    const res = await request.get(`${API_BASE}/api/conversations/${id}`, {
        headers: authedHeaders(token),
    });
    const row = res.ok() ? ((await res.json()) as ConversationRow) : null;
    return { status: res.status(), row };
}

async function listConversations(
    request: APIRequestContext,
    token: string,
): Promise<{ conversations: ConversationSummary[]; total: number }> {
    const res = await request.get(`${API_BASE}/api/conversations?limit=50&offset=0`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'list conversations').toBe(200);
    return res.json();
}

test.describe('Chat conversation lifecycle — API CRUD (fresh user)', () => {
    test('create → list → get → rename → append-context → delete (full lifecycle, with truthful 404s)', async ({
        request,
    }) => {
        // Fresh user so list/total counts are exact and the shared DB stays clean.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        // A pristine user starts with zero conversations.
        const before = await listConversations(request, token);
        expect(before.total, 'fresh user has no conversations').toBe(0);
        expect(before.conversations).toHaveLength(0);

        // 1) CREATE — assert the full create shape (no `messages` key on create).
        const originalTitle = `Lifecycle convo ${stamp}`;
        const created = await createConversation(request, token, { title: originalTitle });
        expect(created.id, 'created id present').toBeTruthy();
        expect(created.title).toBe(originalTitle);
        expect(created.userId).toBe(user.user.id);
        expect(created.providerId).toBeNull();
        expect(created.model).toBeNull();
        expect(created).not.toHaveProperty('messages');
        const convId = created.id;

        // 2) LIST — the new conversation surfaces as a summary row.
        const listed = await listConversations(request, token);
        expect(listed.total).toBe(1);
        const summary = listed.conversations.find((c) => c.id === convId);
        expect(summary, 'created conversation appears in list').toBeTruthy();
        expect(summary?.title).toBe(originalTitle);
        // Summary is the trimmed projection — it has no userId/messages.
        expect(summary).not.toHaveProperty('userId');
        expect(summary).not.toHaveProperty('messages');

        // 3) GET by id — full row carries an (empty) messages array.
        const fetched = await getConversation(request, token, convId);
        expect(fetched.status).toBe(200);
        expect(fetched.row?.id).toBe(convId);
        expect(fetched.row?.title).toBe(originalTitle);
        expect(Array.isArray(fetched.row?.messages)).toBeTruthy();
        expect(fetched.row?.messages).toHaveLength(0);

        // 4) PATCH rename — returns 204 No Content (empty body) and persists.
        const renamedTitle = `Renamed lifecycle convo ${stamp}`;
        const patchRes = await request.patch(`${API_BASE}/api/conversations/${convId}`, {
            headers: authedHeaders(token),
            data: { title: renamedTitle },
        });
        expect(patchRes.status(), 'rename returns 204').toBe(204);
        expect((await patchRes.text()).trim(), '204 body is empty').toBe('');

        const afterRename = await getConversation(request, token, convId);
        expect(afterRename.row?.title, 'rename persisted').toBe(renamedTitle);
        // The list summary reflects the new title too.
        const relisted = await listConversations(request, token);
        expect(relisted.conversations.find((c) => c.id === convId)?.title).toBe(renamedTitle);

        // 5) Append a couple of messages so this is a real, populated conversation
        //    before deletion (exercises the message-persistence path inline).
        const appendRes = await request.post(`${API_BASE}/api/conversations/${convId}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: 'How do I configure a deploy provider?' },
                    { role: 'assistant', content: 'Open Plugins and enable a deployment plugin.' },
                ],
            },
        });
        // NestJS @Post default → 201 (no @HttpCode(200) on appendMessages).
        expect(appendRes.status()).toBe(201);
        expect(await appendRes.json()).toMatchObject({ success: true });
        const withMessages = await getConversation(request, token, convId);
        expect(withMessages.row?.messages).toHaveLength(2);
        // Rename is NOT overwritten by the first user message (title already set).
        expect(withMessages.row?.title).toBe(renamedTitle);

        // 6) DELETE — 204, then the conversation is truly gone (GET 404, list empty).
        const delRes = await request.delete(`${API_BASE}/api/conversations/${convId}`, {
            headers: authedHeaders(token),
        });
        expect(delRes.status(), 'delete returns 204').toBe(204);

        const afterDelete = await getConversation(request, token, convId);
        expect(afterDelete.status, 'GET after delete is 404').toBe(404);
        expect(afterDelete.row).toBeNull();

        const emptied = await listConversations(request, token);
        expect(emptied.total, 'list empty after delete').toBe(0);
        expect(emptied.conversations).toHaveLength(0);

        // Re-deleting an already-gone conversation is a truthful 404 (repo.delete → false).
        const reDelete = await request.delete(`${API_BASE}/api/conversations/${convId}`, {
            headers: authedHeaders(token),
        });
        expect(reDelete.status(), 're-delete of missing conversation 404s').toBe(404);

        // PATCH / append against a deleted id also 404 (ownership/existence checked first).
        const patchGone = await request.patch(`${API_BASE}/api/conversations/${convId}`, {
            headers: authedHeaders(token),
            data: { title: 'ghost' },
        });
        expect(patchGone.status()).toBe(404);
        const appendGone = await request.post(`${API_BASE}/api/conversations/${convId}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: 'anyone there?' }] },
        });
        expect(appendGone.status()).toBe(404);
    });

    test('conversation ownership is isolated per user (cross-user GET/DELETE 404)', async ({
        request,
    }) => {
        // Two fresh users; user A's conversation must be invisible to user B.
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        const aliceConv = await createConversation(request, alice.access_token, {
            title: `Alice private ${stamp}`,
        });

        // Bob cannot read Alice's conversation.
        const bobGet = await getConversation(request, bob.access_token, aliceConv.id);
        expect(bobGet.status, "B cannot GET A's conversation").toBe(404);

        // Bob's list does not contain it.
        const bobList = await listConversations(request, bob.access_token);
        expect(bobList.conversations.some((c) => c.id === aliceConv.id)).toBeFalsy();

        // Bob cannot delete it.
        const bobDelete = await request.delete(`${API_BASE}/api/conversations/${aliceConv.id}`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bobDelete.status(), "B cannot DELETE A's conversation").toBe(404);

        // Alice still owns it intact.
        const aliceGet = await getConversation(request, alice.access_token, aliceConv.id);
        expect(aliceGet.status).toBe(200);
        expect(aliceGet.row?.title).toBe(`Alice private ${stamp}`);
    });
});

test.describe('Chat conversation lifecycle — message persistence & ordering (fresh user)', () => {
    test('append messages across batches: they persist in order and auto-title a blank conversation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        // Create with NO title — exercises the auto-title-from-first-user-message path.
        const conv = await createConversation(request, token, {});
        expect(conv.title, 'blank conversation starts untitled').toBeNull();

        // First batch: a user + assistant turn. The first user message sets the title.
        const firstUser = `Plan the Q3 migration for the ${stamp} workspace`;
        const batchOne = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: firstUser },
                    { role: 'assistant', content: 'Sure — here is a three-step plan.' },
                ],
            },
        });
        // NestJS @Post default → 201 (no @HttpCode(200) on appendMessages).
        expect(batchOne.status()).toBe(201);

        const afterFirst = await getConversation(request, token, conv.id);
        expect(afterFirst.row?.messages).toHaveLength(2);
        // Auto-title: <=60 chars → used verbatim.
        expect(afterFirst.row?.title, 'first user message became the title').toBe(firstUser);
        expect(afterFirst.row?.messages?.[0].role).toBe('user');
        expect(afterFirst.row?.messages?.[0].content).toBe(firstUser);
        expect(afterFirst.row?.messages?.[1].role).toBe('assistant');

        // Second batch: another user turn appended AFTER the first two.
        const secondUser = 'Now break step one into subtasks.';
        const batchTwo = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: secondUser }] },
        });
        // NestJS @Post default → 201 (no @HttpCode(200) on appendMessages).
        expect(batchTwo.status()).toBe(201);

        const afterSecond = await getConversation(request, token, conv.id);
        const msgs = afterSecond.row?.messages ?? [];
        expect(msgs, 'three messages total after second batch').toHaveLength(3);

        // Strict append-order assertion (createdAt is non-decreasing, content sequence stable).
        expect(msgs.map((m) => m.content)).toEqual([
            firstUser,
            'Sure — here is a three-step plan.',
            secondUser,
        ]);
        const times = msgs.map((m) => new Date(m.createdAt).getTime());
        for (let i = 1; i < times.length; i++) {
            expect(times[i], 'messages ordered by createdAt ASC').toBeGreaterThanOrEqual(
                times[i - 1],
            );
        }
        // Every persisted message carries the conversation id + a server-assigned id.
        for (const m of msgs) {
            expect(m.id).toBeTruthy();
            expect(m.conversationId).toBe(conv.id);
        }

        // The title set on the first batch is NOT overwritten by the later user message.
        expect(afterSecond.row?.title).toBe(firstUser);
    });

    test('a long first user message is truncated to a 60-char title (57 + ellipsis)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // 80-char single-line message → controller truncates to substring(0,57)+'...'.
        const longMsg = 'A'.repeat(80);
        const res = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: longMsg }] },
        });
        // NestJS @Post default → 201 (no @HttpCode(200) on appendMessages).
        expect(res.status()).toBe(201);

        const fetched = await getConversation(request, token, conv.id);
        const title = fetched.row?.title ?? '';
        expect(title.length, 'truncated title is 60 chars').toBe(60);
        expect(title.endsWith('...')).toBeTruthy();
        expect(title.startsWith('A'.repeat(57))).toBeTruthy();
        // The full untruncated content is still persisted on the message itself.
        expect(fetched.row?.messages?.[0].content).toBe(longMsg);
    });
});

test.describe('Chat conversation lifecycle — in-panel history UI (seeded user)', () => {
    test('a conversation created via API surfaces in the chat panel History list', async ({
        page,
        request,
    }) => {
        // This conversation must belong to the SEEDED user (the one the browser's
        // storageState authenticates as) so the History panel — which lists the
        // logged-in user's own conversations — can render it.
        const token = await seededToken(request);
        const uniqueTitle = `History panel probe ${Date.now().toString(36)}`;
        const conv = await createConversation(request, token, { title: uniqueTitle });

        try {
            // Open the chat side-panel via the chat-panel-open cookie before the
            // first authenticated navigation (the dashboard layout reads it).
            const base = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
            await page.context().addCookies([
                { name: 'chat-panel-open', value: '1', url: new URL(base).origin },
                { name: 'sidebar-collapsed', value: '0', url: new URL(base).origin },
            ]);

            // Navigate to a dashboard route, recovering from a transient cold
            // auth-redirect to /login under `next dev`.
            for (let attempt = 0; attempt < 3; attempt++) {
                await page.goto('/works', { waitUntil: 'domcontentloaded' });
                if (!/\/login(\?|$)/.test(page.url())) break;
                await page.waitForTimeout(1_500);
            }

            // The toolbar History button is present even with an empty transcript.
            const historyButton = page.getByRole('button', { name: 'History' });
            await expect(historyButton).toBeVisible({ timeout: 45_000 });

            // Hydration race under `next dev`: the first click can be swallowed
            // pre-hydration. Retry the open until the History view (its back-arrow
            // header + our row, or the empty state) actually renders.
            const titleRow = page.getByText(uniqueTitle, { exact: false }).first();
            const emptyState = page.getByText(HISTORY_EMPTY, { exact: false });

            await expect(async () => {
                await historyButton.click({ timeout: 5_000 }).catch(() => {});
                // The History view replaces the toolbar; assert one of the two
                // truthful terminal states is visible.
                await expect(titleRow.or(emptyState).first()).toBeVisible({ timeout: 5_000 });
            }).toPass({ timeout: 45_000 });

            // We created a conversation for THIS user, so the list must NOT be empty
            // and must contain our row. (The refreshConversations() call on mount
            // re-fetches from the API, so the freshly created row is included.)
            await expect(
                emptyState,
                'history is not empty — we created a conversation',
            ).toHaveCount(0);
            await expect(titleRow, 'created conversation surfaces in History').toBeVisible({
                timeout: 15_000,
            });
        } finally {
            // Clean up so we don't leave rows on the shared seeded user.
            await request
                .delete(`${API_BASE}/api/conversations/${conv.id}`, {
                    headers: authedHeaders(token),
                })
                .catch(() => {});
        }
    });
});

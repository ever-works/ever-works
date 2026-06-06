import {
    test,
    expect,
    type APIRequestContext,
    type Page,
    type BrowserContext,
} from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { loginViaUI } from './helpers/auth';

/**
 * Chat HISTORY UI — REAL multi-step, cross-feature integration flows.
 *
 * Drives the in-panel chat History view (apps/web/src/components/ai/ChatHistory.tsx,
 * reached via ChatInterface → ChatToolbar "History" button → showHistory state) end
 * to end against the live conversations API + the chat side-panel UI. This file is
 * COMPLEMENTARY to the existing chat specs — it does NOT re-run their flows:
 *   - flow-chat-conversation-lifecycle.spec.ts → API CRUD lifecycle + a single
 *     "created convo surfaces in History" UI assertion.
 *   - conversation-history-persistence.spec.ts → create/append/rename + one History
 *     surface assertion.
 *   - flow-chat-roundtrip-adaptive / chat-ui-roundtrip → the composer round-trip.
 * NEW here: opening the History panel from a populated transcript; the genuine
 * EMPTY state on a fresh user; REOPENING a conversation from History with its
 * messages intact back in the transcript; DELETING a row from History (hover
 * trash) and watching it disappear; relative-date labelling (Today) + newest-first
 * ORDERING with an append-bump reorder; and the active-row highlight when the
 * currently-loaded conversation is shown in the list.
 *
 * VERIFIED API SHAPES (probed live against http://127.0.0.1:3100 before writing):
 *   POST   /api/auth/register  { username, email, password } → { access_token, user:{id} }
 *   POST   /api/auth/login     { email, password } ONLY        → { access_token }
 *   POST   /api/conversations  { title?, providerId? }
 *      → 201 { id, userId, title|null, providerId|null, model|null, metadata|null,
 *              tenantId|null, organizationId|null, createdAt, updatedAt }  (NO messages)
 *   GET    /api/conversations?limit&offset
 *      → 200 { conversations:[{ id, title, providerId, model, createdAt, updatedAt }],
 *              total }  — ORDER BY updatedAt DESC, user-scoped (ConversationRepository.findByUser).
 *   GET    /api/conversations/:id → full row + messages:[{ id, conversationId, role,
 *              content, parts, model, usage, createdAt }] (ASC by createdAt); 404 if not owned.
 *   POST   /api/conversations/:id/messages { messages:[{ role, content }] }
 *      → 201 { success:true }; persists in order; first user msg auto-titles a NULL-title
 *              row; ALSO touches conversation.updatedAt (verified: appending bumps a row to
 *              the top of the updatedAt-DESC list).
 *   DELETE /api/conversations/:id  → 204; subsequent GET → 404.
 *   DELETE /api/conversations      → 200 { deleted:N }  (delete-ALL for the user).
 *
 * UI CONTRACT (ChatHistory.tsx + ChatToolbar.tsx, i18n dashboard.aiChat.*):
 *   - Toolbar "History" button (label = t('history') = "History"); always present.
 *   - History view header = the same "History" label, preceded by a back-arrow <button>.
 *   - Empty state text = t('historyEmpty') =
 *       "No conversations yet. Start a chat to see your history here."
 *   - Each row renders `conv.title || t('historyUntitled')` ("Untitled conversation")
 *     plus a relative date via formatDate(conv.updatedAt): diffDays 0 → t('historyToday')
 *     "Today"; 1 → "Yesterday"; <7 → t('historyDaysAgo',{days}) "{n}d ago"; else locale date.
 *   - Clicking a row → loadConversation(id) (GET :id, setMessages) then onClose() → back
 *     to the transcript view with that conversation's messages rendered.
 *   - Hovering a row reveals a trash <button>; clicking it → deleteConv(id) (DELETE :id)
 *     and optimistically removes the row from the list.
 *   - The currently-loaded conversationId row gets an "active" style; selecting it loads
 *     it (the active row is persisted in localStorage `chat-active-conversation`).
 *
 * Because updatedAt is SERVER-controlled (always ~now on create/append), API-created
 * rows always render "Today"; Yesterday / "Nd ago" can't be deterministically forced via
 * the public API, so flow 5 asserts the Today label + the updatedAt-DESC reorder instead.
 *
 * CROSS-SPEC ISOLATION: the seeded user's history is shared, so seeded-user flows use
 * UNIQUE titles, assert with .first()/toContain (never exact counts / never the global
 * empty-state), and DELETE every row they create in a finally. The genuine empty-state
 * (flow 2) runs on a FRESH registerUserViaAPI() user signed into its OWN isolated browser
 * context, so its history is provably empty without touching the seeded user.
 */

const HISTORY_EMPTY = 'No conversations yet. Start a chat to see your history here.';
const HISTORY_UNTITLED = 'Untitled conversation';
const HISTORY_LABEL = 'History';
const LABEL_TODAY = 'Today';

interface ConversationRow {
    id: string;
    userId: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
    messages?: Array<{ id: string; role: string; content: string }>;
}

function baseOrigin(baseURL: string | undefined): string {
    return new URL(baseURL ?? 'http://localhost:3000').origin;
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
    title?: string,
): Promise<ConversationRow> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: title === undefined ? {} : { title },
    });
    expect(res.status(), 'create conversation').toBe(201);
    return res.json();
}

async function appendMessages(
    request: APIRequestContext,
    token: string,
    id: string,
    messages: Array<{ role: string; content: string }>,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/conversations/${id}/messages`, {
        headers: authedHeaders(token),
        data: { messages },
    });
    // NestJS @Post default → 201 (appendMessages has no @HttpCode override).
    expect(res.status(), 'append messages').toBe(201);
    expect(await res.json()).toMatchObject({ success: true });
}

async function deleteConversation(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<void> {
    await request
        .delete(`${API_BASE}/api/conversations/${id}`, { headers: authedHeaders(token) })
        .catch(() => {});
}

async function listIds(request: APIRequestContext, token: string): Promise<ConversationRow[]> {
    const res = await request.get(`${API_BASE}/api/conversations?limit=100&offset=0`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'list conversations').toBe(200);
    return (await res.json()).conversations;
}

/**
 * Open the chat side-panel on a dashboard route for the page's logged-in user.
 * Sets the server-read chat-panel-open cookie BEFORE the first navigation, then
 * recovers from a transient cold auth-redirect to /login under `next dev`.
 */
async function openChatPanelFor(page: Page, origin: string, route = '/works'): Promise<void> {
    await page.context().addCookies([
        { name: 'chat-panel-open', value: '1', url: origin },
        { name: 'sidebar-collapsed', value: '0', url: origin },
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        if (!/\/login(\?|$)/.test(page.url())) break;
        await page.waitForTimeout(1_500);
    }
}

/**
 * Click the toolbar "History" button until the History view actually renders.
 * Under `next dev` the first click can be swallowed pre-hydration, so retry until
 * either a known row, the empty-state, or the back-arrow header is visible.
 */
async function openHistoryView(page: Page, anchor: ReturnType<Page['getByText']>): Promise<void> {
    const historyButton = page.getByRole('button', { name: HISTORY_LABEL }).first();
    await expect(historyButton).toBeVisible({ timeout: 45_000 });
    await expect(async () => {
        await historyButton.click({ timeout: 5_000 }).catch(() => {});
        await expect(anchor.first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
}

test.describe('Chat history UI — open / list / reopen / delete / order (seeded user)', () => {
    test('History opens from a populated transcript and lists multiple created conversations', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);
        const titleA = `HistList A ${stamp}`;
        const titleB = `HistList B ${stamp}`;
        const created: string[] = [];

        try {
            // Two distinct, populated conversations owned by the seeded UI user.
            const convA = await createConversation(request, token, titleA);
            created.push(convA.id);
            await appendMessages(request, token, convA.id, [
                { role: 'user', content: `A question ${stamp}` },
                { role: 'assistant', content: `A answer ${stamp}` },
            ]);
            const convB = await createConversation(request, token, titleB);
            created.push(convB.id);
            await appendMessages(request, token, convB.id, [
                { role: 'user', content: `B question ${stamp}` },
            ]);

            await openChatPanelFor(page, baseOrigin(baseURL));

            const rowA = page.getByText(titleA, { exact: false });
            const rowB = page.getByText(titleB, { exact: false });
            await openHistoryView(page, rowA.or(rowB));

            // We just created two conversations for THIS user → list is NOT empty and
            // contains BOTH rows (refreshConversations() on mount re-fetches them).
            await expect(page.getByText(HISTORY_EMPTY, { exact: false })).toHaveCount(0);
            await expect(rowA, 'conversation A appears in History').toBeVisible({
                timeout: 15_000,
            });
            await expect(rowB, 'conversation B appears in History').toBeVisible({
                timeout: 15_000,
            });

            // The History header (back-arrow + label) confirms we're in the list view.
            await expect(page.getByText(HISTORY_LABEL, { exact: true }).first()).toBeVisible({
                timeout: 10_000,
            });

            // Fresh rows carry a "Today" relative-date label (updatedAt ~ now).
            await expect(page.getByText(LABEL_TODAY, { exact: true }).first()).toBeVisible({
                timeout: 10_000,
            });
        } finally {
            for (const id of created) await deleteConversation(request, token, id);
        }
    });

    test('reopening a conversation from History restores its messages into the transcript', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);
        const title = `HistReopen ${stamp}`;
        const userMsg = `Reopen probe user message ${stamp}`;
        const assistantMsg = `Reopen probe assistant reply ${stamp}`;
        let convId = '';

        try {
            const conv = await createConversation(request, token, title);
            convId = conv.id;
            await appendMessages(request, token, convId, [
                { role: 'user', content: userMsg },
                { role: 'assistant', content: assistantMsg },
            ]);

            await openChatPanelFor(page, baseOrigin(baseURL));

            const row = page.getByText(title, { exact: false }).first();
            await openHistoryView(page, row);
            await expect(row, 'target conversation present in History').toBeVisible({
                timeout: 15_000,
            });

            // Click the row → loadConversation(id) → setMessages(...) → onClose() returns
            // to the transcript view with BOTH persisted messages rendered as bubbles.
            await expect(async () => {
                await row.click({ timeout: 5_000 }).catch(() => {});
                await expect(page.getByText(userMsg, { exact: false }).first()).toBeVisible({
                    timeout: 5_000,
                });
            }).toPass({ timeout: 30_000 });

            await expect(
                page.getByText(userMsg, { exact: false }).first(),
                'persisted user message restored',
            ).toBeVisible({ timeout: 15_000 });
            await expect(
                page.getByText(assistantMsg, { exact: false }).first(),
                'persisted assistant message restored',
            ).toBeVisible({ timeout: 15_000 });

            // We're back in the transcript (composer present), not the History list.
            await expect(page.getByPlaceholder('Ask me anything...')).toBeVisible({
                timeout: 15_000,
            });
        } finally {
            await deleteConversation(request, token, convId);
        }
    });

    test('deleting a conversation from the History row removes it from the list (and API)', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);
        const keepTitle = `HistKeep ${stamp}`;
        const dropTitle = `HistDrop ${stamp}`;
        const created: string[] = [];

        try {
            const keep = await createConversation(request, token, keepTitle);
            created.push(keep.id);
            const drop = await createConversation(request, token, dropTitle);
            created.push(drop.id);

            await openChatPanelFor(page, baseOrigin(baseURL));

            const keepRow = page.getByText(keepTitle, { exact: false }).first();
            const dropRow = page.getByText(dropTitle, { exact: false }).first();
            await openHistoryView(page, keepRow.or(dropRow));
            await expect(dropRow, 'row to delete is present').toBeVisible({ timeout: 15_000 });
            await expect(keepRow, 'row to keep is present').toBeVisible({ timeout: 15_000 });

            // The trash button is opacity-0 until row hover; hover to reveal it. It's the
            // only <button> inside the row container (the row itself is role=button div).
            const rowContainer = dropRow.locator('xpath=ancestor::*[@role="button"][1]');
            await rowContainer.hover();
            const trashButton = rowContainer.getByRole('button').first();

            await expect(async () => {
                await rowContainer.hover().catch(() => {});
                await trashButton.click({ timeout: 5_000 }).catch(() => {});
                // Optimistic removal: the dropped row disappears from the list.
                await expect(dropRow).toHaveCount(0, { timeout: 5_000 });
            }).toPass({ timeout: 30_000 });

            // The kept row is still there — only the targeted row was removed.
            await expect(keepRow, 'untouched row survives the delete').toBeVisible({
                timeout: 10_000,
            });

            // Server-side: the dropped conversation is gone; the kept one remains.
            await expect
                .poll(
                    async () => {
                        const rows = await listIds(request, token);
                        return {
                            hasDrop: rows.some((c) => c.id === drop.id),
                            hasKeep: rows.some((c) => c.id === keep.id),
                        };
                    },
                    { timeout: 15_000, message: 'delete propagated to the API' },
                )
                .toEqual({ hasDrop: false, hasKeep: true });

            const goneRes = await request.get(`${API_BASE}/api/conversations/${drop.id}`, {
                headers: authedHeaders(token),
            });
            expect(goneRes.status(), 'deleted conversation GET → 404').toBe(404);
        } finally {
            for (const id of created) await deleteConversation(request, token, id);
        }
    });

    test('an untitled conversation surfaces under the "Untitled conversation" fallback label', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededToken(request);
        let convId = '';

        try {
            // Create with NO title and append NO user message → title stays NULL, so the
            // History row must fall back to t('historyUntitled') = "Untitled conversation".
            const conv = await createConversation(request, token, undefined);
            convId = conv.id;
            expect(conv.title, 'created conversation is untitled').toBeNull();
            // An assistant-only append does NOT auto-title (no first user message).
            await appendMessages(request, token, convId, [
                {
                    role: 'assistant',
                    content: `untitled probe assistant ${Date.now().toString(36)}`,
                },
            ]);

            // Confirm the API still reports a null title before asserting the UI fallback.
            const detail = await request.get(`${API_BASE}/api/conversations/${convId}`, {
                headers: authedHeaders(token),
            });
            expect(detail.status()).toBe(200);
            expect(
                (await detail.json()).title,
                'still untitled after assistant-only append',
            ).toBeNull();

            await openChatPanelFor(page, baseOrigin(baseURL));

            const untitledRow = page.getByText(HISTORY_UNTITLED, { exact: false });
            await openHistoryView(page, untitledRow);

            await expect(
                untitledRow.first(),
                'untitled conversation shows the fallback label',
            ).toBeVisible({ timeout: 15_000 });
            await expect(page.getByText(HISTORY_EMPTY, { exact: false })).toHaveCount(0);
        } finally {
            await deleteConversation(request, token, convId);
        }
    });

    test('history orders newest-first and an append-bump reorders the list (Today label)', async ({
        page,
        request,
        baseURL,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);
        const titleOld = `HistOrder OLD ${stamp}`;
        const titleNew = `HistOrder NEW ${stamp}`;
        const created: string[] = [];

        try {
            // Create OLD first, then NEW → NEW has the later updatedAt initially.
            const convOld = await createConversation(request, token, titleOld);
            created.push(convOld.id);
            await new Promise((r) => setTimeout(r, 1_100)); // updatedAt is second-granular on create
            const convNew = await createConversation(request, token, titleNew);
            created.push(convNew.id);

            // Sanity: among OUR two rows, NEW currently precedes OLD in the API list.
            await expect
                .poll(
                    async () => {
                        const rows = await listIds(request, token);
                        const ours = rows.filter((c) => created.includes(c.id)).map((c) => c.id);
                        return ours.indexOf(convNew.id) < ours.indexOf(convOld.id);
                    },
                    { timeout: 15_000, message: 'NEW precedes OLD before the bump' },
                )
                .toBe(true);

            await openChatPanelFor(page, baseOrigin(baseURL));

            const rowOld = page.getByText(titleOld, { exact: false }).first();
            const rowNew = page.getByText(titleNew, { exact: false }).first();
            await openHistoryView(page, rowOld.or(rowNew));
            await expect(rowOld).toBeVisible({ timeout: 15_000 });
            await expect(rowNew).toBeVisible({ timeout: 15_000 });

            // Relative-date labelling: both fresh rows render "Today".
            await expect(page.getByText(LABEL_TODAY, { exact: true }).first()).toBeVisible({
                timeout: 10_000,
            });

            // In the rendered DOM order, NEW appears before OLD (list is updatedAt-DESC).
            const orderBefore = await page.evaluate(
                ({ a, b }) => {
                    const bodyText = document.body.innerText;
                    return bodyText.indexOf(a) < bodyText.indexOf(b);
                },
                { a: titleNew, b: titleOld },
            );
            expect(orderBefore, 'NEW renders above OLD before the bump').toBe(true);

            // BUMP: append a message to OLD → touches its updatedAt → it should jump to
            // the top of the updatedAt-DESC list, overtaking NEW.
            await appendMessages(request, token, convOld.id, [
                { role: 'user', content: `bump OLD ${stamp}` },
            ]);

            // API reorder: OLD now precedes NEW among our rows.
            await expect
                .poll(
                    async () => {
                        const rows = await listIds(request, token);
                        const ours = rows.filter((c) => created.includes(c.id)).map((c) => c.id);
                        return ours.indexOf(convOld.id) < ours.indexOf(convNew.id);
                    },
                    { timeout: 15_000, message: 'OLD overtakes NEW after the bump' },
                )
                .toBe(true);

            // UI reorder: re-enter History so refreshConversations re-fetches the now-bumped
            // order on mount. Reload the panel (deterministic under `next dev`) and reopen
            // History rather than depending on the icon-only back-arrow button.
            await openChatPanelFor(page, baseOrigin(baseURL));
            await openHistoryView(page, rowOld.or(rowNew));
            await expect(rowOld).toBeVisible({ timeout: 15_000 });
            await expect(rowNew).toBeVisible({ timeout: 15_000 });

            await expect
                .poll(
                    async () =>
                        page.evaluate(
                            ({ a, b }) => {
                                const bodyText = document.body.innerText;
                                return bodyText.indexOf(a) < bodyText.indexOf(b);
                            },
                            { a: titleOld, b: titleNew },
                        ),
                    { timeout: 15_000, message: 'OLD renders above NEW after the bump (UI)' },
                )
                .toBe(true);
        } finally {
            for (const id of created) await deleteConversation(request, token, id);
        }
    });
});

test.describe('Chat history UI — genuine empty state (fresh isolated user)', () => {
    test('a fresh user with no conversations sees the History empty-state message', async ({
        browser,
        request,
        baseURL,
    }) => {
        // A brand-new user guarantees an EMPTY history without depending on the shared
        // seeded user (whose history other specs mutate). Sign this user into its OWN
        // isolated browser context (empty storageState so it doesn't inherit the seeded
        // auth cookie), then open History and assert the truthful empty state.
        const fresh = await registerUserViaAPI(request);

        // A brand-new user with zero works trips the dashboard's auto-open onboarding
        // wizard (layout-client: shouldAutoOpenOnboarding = totalWorks===0 && !dismissedAt
        // && !completedAt), whose modal portal intercepts clicks and hides the chat
        // panel/History toolbar — so without dismissing it the empty-state never renders.
        // Mark onboarding dismissed server-side (mirrors global-setup for the seeded user)
        // BEFORE the UI login so the post-login server render reads dismissedAt and the
        // wizard stays closed. Best-effort: 404 on older API builds is harmless.
        await request
            .post(`${API_BASE}/api/onboarding/dismiss`, {
                headers: authedHeaders(fresh.access_token),
            })
            .catch(() => {});

        // Confirm via API that this user genuinely has zero conversations.
        const rows = await listIds(request, fresh.access_token);
        expect(rows, 'fresh user starts with no conversations').toHaveLength(0);

        const context: BrowserContext = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const page = await context.newPage();
        try {
            // UI auth is cookie-based (Better Auth) — log this fresh user in via the form.
            await loginViaUI(page, { email: fresh.email, password: fresh.password });

            await openChatPanelFor(page, baseOrigin(baseURL));

            const emptyState = page.getByText(HISTORY_EMPTY, { exact: false });
            await openHistoryView(page, emptyState);

            await expect(emptyState, 'empty-state message shown for fresh user').toBeVisible({
                timeout: 15_000,
            });
            // No conversation rows and definitely no "Untitled conversation" fallback row.
            await expect(page.getByText(HISTORY_UNTITLED, { exact: false })).toHaveCount(0);
            // We ARE in the History view (back-arrow header + label present).
            await expect(page.getByText(HISTORY_LABEL, { exact: true }).first()).toBeVisible({
                timeout: 10_000,
            });
        } finally {
            await context.close();
            // Tidy the fresh user's (empty) history; harmless if already empty.
            await request
                .delete(`${API_BASE}/api/conversations`, {
                    headers: authedHeaders(fresh.access_token),
                })
                .catch(() => {});
        }
    });
});

import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Conversation CRUD — DEEP complex integration flows.
 *
 * Source of truth (read + probed live against http://127.0.0.1:3100 before
 * writing): apps/api/src/ai-conversation/conversation.controller.ts (mounted
 * under @Controller('api/conversations')), conversation.repository.ts
 * (@ever-works/agent/database), and the Conversation / ConversationMessage
 * entities (packages/agent/src/entities/).
 *
 * This file deliberately AVOIDS duplicating the existing specs
 * (conversations.spec.ts, conversations-crud.spec.ts,
 * conversation-history-persistence.spec.ts, flow-chat-conversation-lifecycle.spec.ts)
 * which already cover: single create→list→get→rename→delete, cross-user GET/DELETE
 * isolation, two-batch append ordering, auto-title (verbatim + 80-char truncate),
 * and the in-panel History UI. The flows below cover the UNCOVERED surface:
 *
 *   - DELETE /api/conversations          → 200 { deleted: N }  (bulk wipe — NOT in any spec)
 *   - pagination + updatedAt-DESC ordering (limit/offset, total stable, rename re-sorts)
 *   - auto-title BOUNDARY battery (exactly 60 verbatim / 61 → 57+'...' / whitespace
 *     collapse via /\s+/g / first-*user*-wins over system / preset-title no-overwrite)
 *   - message payload fidelity (parts/model/usage round-trip; system+tool roles
 *     persist; empty-messages append is a 201 no-op)
 *   - the full unauthorized verb matrix (401 on every verb incl. anon browser context)
 *     + the missing-id 404 matrix (get/patch/append/delete)
 *   - cross-user DELETE-all isolation (deleteAllByUser is user-scoped)
 *
 * VERIFIED API SHAPES (probed live as a throwaway user):
 *   POST   /api/conversations            { title?, providerId? }
 *      → 201 { id, userId, title|null, providerId|null, model|null, metadata|null,
 *              tenantId|null, organizationId|null, createdAt, updatedAt }  (NO messages key)
 *   GET    /api/conversations?limit=&offset=
 *      → 200 { conversations: [{ id, title, providerId, model, createdAt, updatedAt }],
 *              total }   — ordered updatedAt DESC; `total` is the FULL count (ignores limit);
 *              summary rows carry NO userId/messages/metadata.
 *   GET    /api/conversations/:id        → 200 full row + messages[] (ASC by createdAt);
 *                                          404 { statusCode:404 } when missing / not owned.
 *   PATCH  /api/conversations/:id        { title } → 204 No Content; 404 if missing.
 *   POST   /api/conversations/:id/messages { messages:[{ role, content, parts?, model?, usage? }] }
 *      → 201 { success:true }; persists in append order; empty array → 201 no-op (no title).
 *        If the conversation title is falsy, the FIRST user-role message becomes the title:
 *        content.replace(/\s+/g,' ').trim(); len<=60 → verbatim, else substring(0,57)+'...'.
 *        404 if the conversation is missing / not owned.
 *   DELETE /api/conversations/:id        → 204; subsequent GET → 404.
 *   DELETE /api/conversations            → 200 { deleted: N } (wipes ALL of caller's rows).
 *   ALL verbs → 401 without a bearer token.
 */

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

interface ListResponse {
    conversations: ConversationSummary[];
    total: number;
}

async function createConversation(
    request: APIRequestContext,
    token: string,
    body: { title?: string; providerId?: string } = {},
): Promise<ConversationRow> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), 'create conversation → 201').toBe(201);
    return res.json();
}

async function listConversations(
    request: APIRequestContext,
    token: string,
    query = 'limit=100&offset=0',
): Promise<ListResponse> {
    const res = await request.get(`${API_BASE}/api/conversations?${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'list conversations → 200').toBe(200);
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

async function appendMessages(
    request: APIRequestContext,
    token: string,
    id: string,
    messages: Array<Record<string, unknown>>,
): Promise<number> {
    const res = await request.post(`${API_BASE}/api/conversations/${id}/messages`, {
        headers: authedHeaders(token),
        data: { messages },
    });
    return res.status();
}

// A throwaway uuid that no row can own — drives the missing-id 404 matrix.
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

test.describe('Conversation CRUD deep — bulk delete-all', () => {
    test('DELETE /api/conversations wipes every row and returns the deleted count', async ({
        request,
    }) => {
        // Fresh user → the delete-all count is EXACT (no pre-existing rows).
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        // A pristine user owns nothing; delete-all on an empty mailbox is a truthful 0.
        const emptyWipe = await request.delete(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
        });
        expect(emptyWipe.status(), 'delete-all → 200 even when empty').toBe(200);
        expect(await emptyWipe.json(), 'nothing to delete yet').toEqual({ deleted: 0 });

        // Build a populated set: 3 conversations, one of them carrying messages.
        const a = await createConversation(request, token, { title: `wipe-A ${stamp}` });
        const b = await createConversation(request, token, { title: `wipe-B ${stamp}` });
        const c = await createConversation(request, token, { title: `wipe-C ${stamp}` });
        expect(
            await appendMessages(request, token, c.id, [
                { role: 'user', content: 'keep me until the purge' },
                { role: 'assistant', content: 'understood' },
            ]),
            'seed messages on C → 201',
        ).toBe(201);

        const before = await listConversations(request, token);
        expect(before.total, 'three conversations exist before wipe').toBe(3);

        // The wipe reports exactly how many rows it removed.
        const wipe = await request.delete(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
        });
        expect(wipe.status(), 'delete-all → 200').toBe(200);
        expect(await wipe.json(), 'deleted count matches the populated set').toEqual({
            deleted: 3,
        });

        // Every conversation is truly gone: empty list + per-id 404 (cascade took the messages too).
        const after = await listConversations(request, token);
        expect(after.total, 'list empty after wipe').toBe(0);
        expect(after.conversations, 'no summary rows after wipe').toHaveLength(0);
        for (const id of [a.id, b.id, c.id]) {
            const gone = await getConversation(request, token, id);
            expect(gone.status, `GET ${id} after wipe → 404`).toBe(404);
        }

        // A second wipe is idempotent: nothing left, count 0 (NOT a 404 — bulk delete has no
        // existence precondition, unlike single-id delete which 404s on a missing row).
        const reWipe = await request.delete(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
        });
        expect(reWipe.status(), 're-wipe → 200').toBe(200);
        expect(await reWipe.json(), 're-wipe deletes nothing').toEqual({ deleted: 0 });
    });

    test('delete-all is user-scoped: wiping user A leaves user B untouched', async ({
        request,
    }) => {
        // deleteAllByUser keys on the caller's userId — a cross-user wipe must be impossible.
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        await createConversation(request, alice.access_token, { title: `alice-1 ${stamp}` });
        await createConversation(request, alice.access_token, { title: `alice-2 ${stamp}` });
        const bob1 = await createConversation(request, bob.access_token, {
            title: `bob-1 ${stamp}`,
        });
        const bob2 = await createConversation(request, bob.access_token, {
            title: `bob-2 ${stamp}`,
        });

        // Alice wipes her own mailbox.
        const aliceWipe = await request.delete(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(alice.access_token),
        });
        expect(aliceWipe.status()).toBe(200);
        expect(await aliceWipe.json(), 'Alice wipes only her two rows').toEqual({ deleted: 2 });

        // Alice is empty; Bob is fully intact (count + both ids still readable).
        const aliceList = await listConversations(request, alice.access_token);
        expect(aliceList.total, 'Alice has nothing left').toBe(0);

        const bobList = await listConversations(request, bob.access_token);
        expect(bobList.total, "Bob's two conversations survive Alice's wipe").toBe(2);
        const bobIds = bobList.conversations.map((c) => c.id).sort();
        expect(bobIds).toEqual([bob1.id, bob2.id].sort());
        expect((await getConversation(request, bob.access_token, bob1.id)).status).toBe(200);
        expect((await getConversation(request, bob.access_token, bob2.id)).status).toBe(200);
    });
});

test.describe('Conversation CRUD deep — pagination & updatedAt ordering', () => {
    test('list pages newest-first by updatedAt with a stable total, and re-sorts on rename', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const stamp = Date.now().toString(36);

        // Create 5 conversations with a small gap so updatedAt strictly increases.
        // Newest creation = top of the DESC-ordered list.
        const ids: string[] = [];
        const titles: string[] = [];
        for (let i = 0; i < 5; i++) {
            const title = `page-${i}-${stamp}`;
            const row = await createConversation(request, token, { title });
            ids.push(row.id);
            titles.push(title);
            // 1100ms ≥ 1s so the second-precision updatedAt advances between rows.
            if (i < 4) await new Promise((r) => setTimeout(r, 1_100));
        }
        // Creation order page-0..page-4 → DESC order is page-4..page-0.
        const expectedDesc = [...titles].reverse();

        // total reflects the FULL count, independent of the page window.
        const firstPage = await listConversations(request, token, 'limit=2&offset=0');
        expect(firstPage.total, 'total is the full count, not the page size').toBe(5);
        expect(
            firstPage.conversations.map((c) => c.title),
            'page 1 = two newest',
        ).toEqual(expectedDesc.slice(0, 2));

        const secondPage = await listConversations(request, token, 'limit=2&offset=2');
        expect(secondPage.total).toBe(5);
        expect(
            secondPage.conversations.map((c) => c.title),
            'page 2 = next two',
        ).toEqual(expectedDesc.slice(2, 4));

        const thirdPage = await listConversations(request, token, 'limit=2&offset=4');
        expect(thirdPage.total).toBe(5);
        expect(
            thirdPage.conversations.map((c) => c.title),
            'page 3 = the remaining one',
        ).toEqual(expectedDesc.slice(4, 5));

        // Pages are disjoint and reassemble into the full DESC ordering (no gaps/overlaps).
        const reassembled = [
            ...firstPage.conversations,
            ...secondPage.conversations,
            ...thirdPage.conversations,
        ].map((c) => c.title);
        expect(reassembled, 'paged windows reassemble into the full DESC sequence').toEqual(
            expectedDesc,
        );

        // Summary projection carries no heavy fields (select-list in findByUser).
        for (const c of firstPage.conversations) {
            expect(c).not.toHaveProperty('userId');
            expect(c).not.toHaveProperty('messages');
            expect(c).not.toHaveProperty('metadata');
        }

        // Renaming the OLDEST (page-0) touches its updatedAt → it jumps to the FRONT.
        // updatedAt is sqlite second-precision: the last creation (page-4) had NO trailing
        // sleep, so without this guard the PATCH can land in the SAME wall-clock second as
        // page-4 and TIE it (verified live: the rename does bump updatedAt, but a same-second
        // tie is broken non-deterministically and page-4 can stay on top). Sleep ≥1s so the
        // touched updatedAt is strictly newer than every existing row, matching the 1100ms
        // gaps used between creations above.
        await new Promise((r) => setTimeout(r, 1_100));
        const oldest = ids[0];
        const patch = await request.patch(`${API_BASE}/api/conversations/${oldest}`, {
            headers: authedHeaders(token),
            data: { title: `bumped-${stamp}` },
        });
        expect(patch.status(), 'rename → 204').toBe(204);

        await expect
            .poll(async () => (await listConversations(request, token)).conversations[0]?.id, {
                timeout: 15_000,
                message: 'renamed (touched) conversation rises to the top',
            })
            .toBe(oldest);

        const bumped = await listConversations(request, token);
        expect(bumped.total, 'rename does not change the count').toBe(5);
        expect(bumped.conversations[0].title).toBe(`bumped-${stamp}`);
    });
});

test.describe('Conversation CRUD deep — auto-title boundary battery', () => {
    test('a 60-char first user message is the title verbatim; 61 chars truncates to 57+ellipsis', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Exactly 60 single-line chars → boundary of the <=60 verbatim branch.
        const exact60 = 'X'.repeat(60);
        const c60 = await createConversation(request, token, {});
        expect(c60.title, 'blank conversation starts untitled').toBeNull();
        expect(
            await appendMessages(request, token, c60.id, [{ role: 'user', content: exact60 }]),
        ).toBe(201);
        const got60 = await getConversation(request, token, c60.id);
        expect(got60.row?.title, '60-char title used verbatim').toBe(exact60);
        expect(got60.row?.title?.length, 'verbatim length is 60').toBe(60);
        expect(got60.row?.title?.endsWith('...'), 'no ellipsis at the boundary').toBe(false);

        // Exactly 61 chars → first over-the-line case: substring(0,57) + '...' = 60 chars.
        const len61 = 'Y'.repeat(61);
        const c61 = await createConversation(request, token, {});
        expect(
            await appendMessages(request, token, c61.id, [{ role: 'user', content: len61 }]),
        ).toBe(201);
        const got61 = await getConversation(request, token, c61.id);
        const title61 = got61.row?.title ?? '';
        expect(title61.length, '61-char message truncates to a 60-char title').toBe(60);
        expect(title61.endsWith('...'), 'truncated title carries the ellipsis').toBe(true);
        expect(title61.startsWith('Y'.repeat(57)), 'first 57 chars are the prefix').toBe(true);
        // The full, untruncated content is still persisted on the message itself.
        expect(got61.row?.messages?.[0].content, 'message content is never truncated').toBe(len61);
    });

    test('auto-title collapses whitespace, ignores non-user roles, and never overwrites a preset title', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // (a) Multiline / tabbed / padded content → /\s+/g collapses to single spaces + trim.
        //     A leading SYSTEM message must be skipped; the first USER message wins the title.
        const messy = '  Plan   the\n\n  Q3\tmigration  ';
        const cWs = await createConversation(request, token, {});
        expect(
            await appendMessages(request, token, cWs.id, [
                {
                    role: 'system',
                    content: 'You are a helpful planner. (should NOT become the title)',
                },
                { role: 'user', content: messy },
                { role: 'assistant', content: 'Here is the plan.' },
            ]),
        ).toBe(201);
        const wsRow = await getConversation(request, token, cWs.id);
        expect(wsRow.row?.title, 'whitespace-normalized first USER message becomes the title').toBe(
            'Plan the Q3 migration',
        );
        // All three roles persisted in append order (system is stored, just not title-eligible).
        expect(wsRow.row?.messages?.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);

        // (b) A conversation CREATED with a title is never re-titled by the first user message.
        const preset = `Preset title ${Date.now().toString(36)}`;
        const cPreset = await createConversation(request, token, { title: preset });
        expect(cPreset.title).toBe(preset);
        expect(
            await appendMessages(request, token, cPreset.id, [
                { role: 'user', content: 'This text must NOT replace the preset title' },
            ]),
        ).toBe(201);
        const presetRow = await getConversation(request, token, cPreset.id);
        expect(presetRow.row?.title, 'preset title survives the first user message').toBe(preset);

        // (c) An append batch with NO user message leaves a blank conversation untitled.
        const cNoUser = await createConversation(request, token, {});
        expect(
            await appendMessages(request, token, cNoUser.id, [
                { role: 'assistant', content: 'Proactive assistant opener with no user turn' },
            ]),
        ).toBe(201);
        const noUserRow = await getConversation(request, token, cNoUser.id);
        expect(noUserRow.row?.title, 'no user message → title stays null').toBeNull();
        expect(noUserRow.row?.messages?.[0].role).toBe('assistant');
    });
});

test.describe('Conversation CRUD deep — message payload fidelity', () => {
    test('parts/model/usage and system+tool roles round-trip; empty append is a 201 no-op', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const conv = await createConversation(request, token, {});

        // An empty messages array is a valid 201 no-op: nothing persists, no title is set.
        expect(await appendMessages(request, token, conv.id, []), 'empty append → 201').toBe(201);
        const afterEmpty = await getConversation(request, token, conv.id);
        expect(afterEmpty.row?.messages, 'empty append persists nothing').toHaveLength(0);
        expect(afterEmpty.row?.title, 'empty append sets no title').toBeNull();

        // A rich batch spanning all four roles, with parts/model/usage on the assistant turn.
        const parts = [{ type: 'text', text: 'hi there' }];
        const usage = { promptTokens: 12, completionTokens: 7, totalTokens: 19 };
        expect(
            await appendMessages(request, token, conv.id, [
                { role: 'system', content: 'system primer' },
                { role: 'user', content: 'hi there' },
                {
                    role: 'assistant',
                    content: 'hello back',
                    parts,
                    model: 'gpt-4o-mini',
                    usage,
                },
                { role: 'tool', content: '{"result":"ok"}' },
            ]),
            'rich append → 201',
        ).toBe(201);

        const row = (await getConversation(request, token, conv.id)).row;
        const msgs = row?.messages ?? [];
        expect(msgs, 'all four messages persisted').toHaveLength(4);
        // Append order is preserved across all roles.
        expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);

        // The assistant turn round-trips its parts / model / usage verbatim.
        const assistant = msgs.find((m) => m.role === 'assistant');
        expect(assistant?.parts, 'parts round-trip').toEqual(parts);
        expect(assistant?.model, 'model round-trip').toBe('gpt-4o-mini');
        expect(assistant?.usage, 'usage round-trip').toEqual(usage);

        // Plain turns default parts/model/usage to null (nullable columns, never sent).
        const userMsg = msgs.find((m) => m.role === 'user');
        expect(userMsg?.model, 'user message has no model').toBeNull();
        expect(userMsg?.usage, 'user message has no usage').toBeNull();

        // Every persisted message carries the conversation id + a server-assigned id, and a
        // non-decreasing createdAt (appendMessages stamps baseTime+i to guarantee the order).
        const times = msgs.map((m) => new Date(m.createdAt).getTime());
        for (let i = 0; i < msgs.length; i++) {
            expect(msgs[i].id, 'server-assigned message id').toBeTruthy();
            expect(msgs[i].conversationId, 'message points at its conversation').toBe(conv.id);
            if (i > 0) {
                expect(times[i], 'messages ordered by createdAt ASC').toBeGreaterThanOrEqual(
                    times[i - 1],
                );
            }
        }

        // The first USER message (skipping the leading system row) won the title.
        expect(row?.title, 'first user message titled the conversation').toBe('hi there');
    });
});

test.describe('Conversation CRUD deep — auth gate & missing-id matrix', () => {
    test('every verb requires a bearer token (401), including from an anonymous browser context', async ({
        request,
        browser,
    }) => {
        // No Authorization header on ANY verb → 401 across the board.
        const noAuth = [
            () => request.get(`${API_BASE}/api/conversations`),
            () => request.post(`${API_BASE}/api/conversations`, { data: { title: 'nope' } }),
            () => request.get(`${API_BASE}/api/conversations/${MISSING_ID}`),
            () =>
                request.patch(`${API_BASE}/api/conversations/${MISSING_ID}`, {
                    data: { title: 'nope' },
                }),
            () =>
                request.post(`${API_BASE}/api/conversations/${MISSING_ID}/messages`, {
                    data: { messages: [] },
                }),
            () => request.delete(`${API_BASE}/api/conversations/${MISSING_ID}`),
            () => request.delete(`${API_BASE}/api/conversations`),
        ];
        for (const call of noAuth) {
            const res = await call();
            expect(res.status(), 'unauthenticated conversation verb → 401').toBe(401);
        }

        // A bare newContext() would INHERIT the seeded storageState cookie; an explicitly
        // EMPTY storageState proves the API rejects truly anonymous browser-originated calls.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonList = await anon.request.get(`${API_BASE}/api/conversations`);
            expect(anonList.status(), 'anonymous browser context list → 401').toBe(401);
            const anonCreate = await anon.request.post(`${API_BASE}/api/conversations`, {
                data: { title: 'anon' },
            });
            expect(anonCreate.status(), 'anonymous browser context create → 401').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('authenticated verbs against a non-existent / non-owned id all 404 (not 401/500)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // GET / PATCH / append / DELETE against a uuid this user does not own → uniform 404.
        const get = await request.get(`${API_BASE}/api/conversations/${MISSING_ID}`, {
            headers: authedHeaders(token),
        });
        expect(get.status(), 'GET missing → 404').toBe(404);

        const patch = await request.patch(`${API_BASE}/api/conversations/${MISSING_ID}`, {
            headers: authedHeaders(token),
            data: { title: 'ghost' },
        });
        expect(patch.status(), 'PATCH missing → 404').toBe(404);

        const append = await request.post(`${API_BASE}/api/conversations/${MISSING_ID}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: 'anyone home?' }] },
        });
        expect(append.status(), 'append to missing → 404').toBe(404);

        const del = await request.delete(`${API_BASE}/api/conversations/${MISSING_ID}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), 'DELETE missing → 404').toBe(404);

        // A foreign user's real conversation is also 404 (ownership is enforced by the same
        // findById(id, userId) gate — indistinguishable from "missing", which is correct).
        const stranger = await registerUserViaAPI(request);
        const theirs = await createConversation(request, stranger.access_token, {
            title: `stranger ${Date.now().toString(36)}`,
        });
        const foreignGet = await request.get(`${API_BASE}/api/conversations/${theirs.id}`, {
            headers: authedHeaders(token),
        });
        expect(foreignGet.status(), "GET someone else's conversation → 404").toBe(404);
        const foreignPatch = await request.patch(`${API_BASE}/api/conversations/${theirs.id}`, {
            headers: authedHeaders(token),
            data: { title: 'hijack' },
        });
        expect(foreignPatch.status(), "PATCH someone else's conversation → 404").toBe(404);
        const foreignDelete = await request.delete(`${API_BASE}/api/conversations/${theirs.id}`, {
            headers: authedHeaders(token),
        });
        expect(foreignDelete.status(), "DELETE someone else's conversation → 404").toBe(404);

        // The owner's row is untouched by all the failed foreign attempts.
        const ownerView = await getConversation(request, stranger.access_token, theirs.id);
        expect(ownerView.status, 'owner still reads their intact conversation').toBe(200);
        expect(ownerView.row?.title).toBe(theirs.title);
    });
});

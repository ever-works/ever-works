import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * AI conversation ENTITY work-scoping — the conversation/work linkage GAPS.
 *
 * This is the FINAL batch of the +1000 real-flow coverage initiative. It pins
 * the *conversation entity's* work-scoping contract — the durable, queryable
 * linkage surface — which the two sibling chat specs deliberately do NOT touch:
 *   - `flow-chat-work-scoped.spec.ts`        → the X-Work-Id chat COMPLETION
 *     (adaptive 200/422), CREATE-side `forbidNonWhitelisted` rejection, per-USER
 *     GET 404 isolation, per-message model/usage recording.
 *   - `flow-chat-work-scoped-deep.spec.ts`   → implicit work-context resolution,
 *     X-Work-Id as an opaque routing hint, work-scoped KB grounding, recency
 *     reorder (updatedAt DESC), provider⟂work axis, the STREAMING completion.
 * Both center on the chat-streaming layer (X-Work-Id routing). NEITHER pins the
 * conversation-record work-scoping surface. This file fills exactly that gap and
 * does NOT re-drive any completion/streaming/KB/recency assertion.
 *
 * Every status/shape/envelope below was PROBED against the LIVE API
 * (http://127.0.0.1:3100) before assertion. This file is purely conversation-
 * CRUD + works domain — it requires NO AI provider, mail, Redis, or deploy
 * token, so it asserts identically in keyless CI and locally (no adaptivity
 * needed: there is no completion call here).
 *
 * ── Verified API contracts (conversation entity vs. works) ───────────────────
 *
 * The Conversation entity (packages/agent/.../conversation.entity.ts) has NO
 * `workId` column. `CreateConversationDto` whitelists ONLY { title, providerId };
 * `UpdateConversationDto` whitelists ONLY { title } — both under the hardened
 * global ValidationPipe (`forbidNonWhitelisted:true`, apps/api/src/main.ts). So
 * the ONLY durable conversation⇄work linkage today is the TITLE ENCODING
 * (`work:<workId>` convention). The contracts that govern that linkage:
 *
 * GET /api/conversations?limit&offset[&workId]   (conversation.controller.list)
 *   → { conversations:[{ id, title, providerId, model, createdAt, updatedAt }],
 *       total }. The list reads ONLY `limit`/`offset`; a `?workId=` param is
 *   SILENTLY IGNORED (probed: filtering by it returns the SAME rows) — there is
 *   NO native server-side work filter. Clients filter by the `work:<id>` title
 *   prefix on the projection. `limit` is clamped to [1,200] (DoS cap).
 *
 * POST /api/conversations { title?, providerId? } → 201 row (no `messages`).
 *   title>200 → 400 maxLength; providerId>100 → 400 maxLength.
 *
 * PATCH /api/conversations/:id { title } → 204 (re-scopes the title linkage).
 *   title is REQUIRED + maxLength 200; a non-whitelisted `workId` in the body →
 *   400 ["property workId should not exist"] (forbidNonWhitelisted on UPDATE too).
 *
 * POST /api/conversations/:id/messages { messages } → 201 { success:true }.
 *   Auto-title: when the conversation has NO title, the first user message
 *   derives the title; when it ALREADY has a `work:<id>` title that title is
 *   PRESERVED (the work linkage survives message activity). Empty array → 201.
 *
 * DELETE /api/conversations/:id → 204; re-DELETE / nonexistent uuid → 404.
 *
 * `:id` is a @Param ParseUUIDPipe → a non-uuid id → 400
 *   "Validation failed (uuid is expected)".
 *
 * ISOLATION: conversations are strictly per-user. A cross-user GET/PATCH/append/
 *   DELETE on another user's work-conversation → 404 (probed for ALL four verbs
 *   — the siblings only pin the GET 404; the MUTATION 404s are pinned here).
 *
 * ── ISOLATION (test hygiene) ──
 *   Every mutation runs on a FRESH registerUserViaAPI() user; unique work ids /
 *   suffixes per test (a per-test counter, NOT a module-scope clock). Assertions
 *   tolerate pre-existing rows (toContain / filter), never exact global counts.
 */

interface ConversationRow {
    id: string;
    userId?: string;
    title?: string | null;
    providerId?: string | null;
    model?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
    messages?: Array<{
        id: string;
        role: string;
        content: string;
        model?: string | null;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
    }>;
}

interface ConversationList {
    conversations: ConversationRow[];
    total: number;
}

interface ValidationError {
    message?: string | string[];
    error?: string;
    statusCode?: number;
}

/** Per-test unique suffix (NOT a module-scope clock — evaluated inside each test). */
let COUNTER = 0;
const suffix = (): string =>
    `${Date.now().toString(36)}${(COUNTER++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A syntactically valid uuid encoding a fictitious work (the linkage is the title, not an FK). */
const fakeWorkId = (n: number): string =>
    `${n.toString().padStart(8, '0')}-1111-2222-3333-444444444444`;

/** Create a conversation whose title encodes a work association. Returns the parsed row. */
async function createWorkConversation(
    request: APIRequestContext,
    token: string,
    workId: string,
    titleSuffix = '',
): Promise<ConversationRow> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: { title: `work:${workId}${titleSuffix}`, providerId: 'openrouter' },
    });
    expect(res.status(), 'create work-conversation → 201').toBe(201);
    return (await res.json()) as ConversationRow;
}

/** List the caller's conversations (high limit), parsed. */
async function listConversations(
    request: APIRequestContext,
    token: string,
    query = 'limit=200',
): Promise<ConversationList> {
    const res = await request.get(`${API_BASE}/api/conversations?${query}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'list conversations → 200').toBe(200);
    return (await res.json()) as ConversationList;
}

/** Flatten a (string | string[]) validation message into a single searchable string. */
function flatMessage(body: ValidationError): string {
    return Array.isArray(body.message) ? body.message.join(' ') : (body.message ?? '');
}

test.describe('AI conversation entity — work-scoping linkage (title-encoded; no native workId)', () => {
    test('Flow 1: the durable work linkage lives in the title — the `?workId=` list filter is SILENTLY IGNORED, clients filter by the `work:<id>` title prefix', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token, 'fresh user bearer token').toHaveLength(32);

        // Two REAL works, plus a third (purely title-encoded) association.
        const s = suffix();
        const workA = await createWorkViaAPI(request, token, {
            name: `Conv Filter A ${s}`,
            slug: `conv-filter-a-${s}`,
        });
        const workB = await createWorkViaAPI(request, token, {
            name: `Conv Filter B ${s}`,
            slug: `conv-filter-b-${s}`,
        });
        expect(workA.id).toBeTruthy();
        expect(workB.id).toBeTruthy();
        expect(workA.id).not.toBe(workB.id);

        const convA = await createWorkConversation(request, token, workA.id);
        const convB = await createWorkConversation(request, token, workB.id);
        expect(convA.id).not.toBe(convB.id);

        // (a) `?workId=<A>` is NOT a server-side filter — BOTH conversations are
        // still returned. This proves the linkage is title-encoded, not an FK
        // the API can filter on. (The siblings never pin this absence.)
        const filteredByA = await listConversations(request, token, `limit=200&workId=${workA.id}`);
        const filteredIds = filteredByA.conversations.map((c) => c.id);
        expect(filteredIds, '?workId filter is ignored → conv A still present').toContain(convA.id);
        expect(
            filteredIds,
            '?workId filter is ignored → conv B (other work) ALSO present',
        ).toContain(convB.id);

        // A garbage `?workId=` is equally ignored (never a 400 — it is not a real param).
        const garbageFilter = await request.get(
            `${API_BASE}/api/conversations?workId=not-a-uuid-param`,
            { headers: authedHeaders(token) },
        );
        expect(garbageFilter.status(), 'garbage ?workId is ignored, not validated → 200').toBe(200);

        // (b) The REAL way to scope a list to a work: filter the projection by the
        // `work:<id>` title prefix client-side. THIS yields exactly the work's convs.
        const all = await listConversations(request, token);
        const scopedToA = all.conversations.filter((c) =>
            (c.title ?? '').startsWith(`work:${workA.id}`),
        );
        const scopedToB = all.conversations.filter((c) =>
            (c.title ?? '').startsWith(`work:${workB.id}`),
        );
        expect(
            scopedToA.map((c) => c.id),
            'title-prefix filter for work A yields exactly conv A',
        ).toEqual([convA.id]);
        expect(
            scopedToB.map((c) => c.id),
            'title-prefix filter for work B yields exactly conv B',
        ).toEqual([convB.id]);

        // (c) The list PROJECTION shape carries no work column — only the
        // title encodes the association. Pin the exact projected key set.
        const rowA = all.conversations.find((c) => c.id === convA.id) as ConversationRow;
        expect(rowA, 'conv A appears in the projection').toBeTruthy();
        expect(Object.keys(rowA).sort(), 'list projection has no workId column').toEqual(
            ['createdAt', 'id', 'model', 'providerId', 'title', 'updatedAt'].sort(),
        );
        expect(
            (rowA as unknown as Record<string, unknown>).workId,
            'no workId key on the projected row',
        ).toBeUndefined();
    });

    test('Flow 2: the `work:<id>` title linkage SURVIVES message activity — auto-title only fires for an empty title, never overwriting a work association', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const wid = fakeWorkId(1);

        // (a) A conversation created WITH a `work:<id>` title. Appending a user
        // message (which would auto-derive a title for an untitled conv) must
        // NOT clobber the work linkage — the association survives the activity.
        const workConv = await createWorkConversation(request, token, wid);
        expect(workConv.title).toBe(`work:${wid}`);

        const append = await request.post(`${API_BASE}/api/conversations/${workConv.id}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: 'an unrelated first message that is NOT the work id' },
                ],
            },
        });
        expect(append.status(), 'append to work-conv → 201').toBe(201);
        expect((await append.json()).success, 'append envelope is {success:true}').toBe(true);

        const reGet = await request.get(`${API_BASE}/api/conversations/${workConv.id}`, {
            headers: authedHeaders(token),
        });
        const reFetched = (await reGet.json()) as ConversationRow;
        expect(
            reFetched.title,
            'work linkage in the title is PRESERVED after message activity',
        ).toBe(`work:${wid}`);

        // (b) CONTRAST: an UNTITLED conversation auto-derives its title from the
        // first user message (the work-less default path) — so the title slot is
        // genuinely "available" only when no work was encoded.
        const untitledRes = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { providerId: 'openrouter' },
        });
        expect(untitledRes.status()).toBe(201);
        const untitled = (await untitledRes.json()) as ConversationRow;
        expect(untitled.title ?? null, 'created untitled → null title').toBeNull();

        const firstMsg = `Build a directory for my work ${suffix()}`;
        const appendUntitled = await request.post(
            `${API_BASE}/api/conversations/${untitled.id}/messages`,
            {
                headers: authedHeaders(token),
                data: { messages: [{ role: 'user', content: firstMsg }] },
            },
        );
        expect(appendUntitled.status()).toBe(201);

        const reGetUntitled = await request.get(`${API_BASE}/api/conversations/${untitled.id}`, {
            headers: authedHeaders(token),
        });
        const derived = (await reGetUntitled.json()) as ConversationRow;
        expect(derived.title, 'untitled conv derives its title from the first user message').toBe(
            firstMsg,
        );
        expect(
            (derived.title ?? '').startsWith('work:'),
            'a derived title is NOT a work linkage (no work was encoded)',
        ).toBeFalsy();
    });

    test('Flow 3: re-scoping a conversation to a DIFFERENT work via PATCH title is durable and reflected in the list projection', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const fromWork = fakeWorkId(2);
        const toWork = fakeWorkId(3);
        const conv = await createWorkConversation(request, token, fromWork);
        expect(conv.title).toBe(`work:${fromWork}`);

        // Move the conversation from work-2 to work-3 by retitling — the only
        // way to "re-scope" a conversation's work association today.
        const newTitle = `work:${toWork}:rescoped-${suffix()}`;
        const patch = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: { title: newTitle },
        });
        expect(patch.status(), 'PATCH title (re-scope) → 204').toBe(204);

        // The re-scope is durable on GET …
        const get = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(((await get.json()) as ConversationRow).title, 'GET reflects the re-scope').toBe(
            newTitle,
        );

        // … and reflected in the list projection used by the history UI.
        const list = await listConversations(request, token);
        const listed = list.conversations.find((c) => c.id === conv.id);
        expect(listed?.title, 'list projection reflects the re-scoped work title').toBe(newTitle);
        expect(
            list.conversations.filter((c) => (c.title ?? '').startsWith(`work:${fromWork}`)),
            'no conversation is scoped to the OLD work after re-scope',
        ).toEqual([]);
    });

    test('Flow 4: PATCH is title-only — a smuggled `workId` is rejected (forbidNonWhitelisted on UPDATE), proving there is no FK re-link path', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const conv = await createWorkConversation(request, token, fakeWorkId(4));

        // The sibling pins forbidNonWhitelisted on CREATE; this pins it on UPDATE
        // — closing the second door through which a real workId FK could be set.
        const smuggle = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: { title: 'new title', workId: fakeWorkId(5) },
        });
        expect(smuggle.status(), 'PATCH rejects non-whitelisted workId → 400').toBe(400);
        const smuggleBody = (await smuggle.json()) as ValidationError;
        expect(flatMessage(smuggleBody), 'rejection names the workId property').toContain('workId');

        // The conversation was NOT mutated by the rejected request.
        const get = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(
            ((await get.json()) as ConversationRow).title,
            'rejected smuggle did not change the title',
        ).toBe(`work:${fakeWorkId(4)}`);

        // title is REQUIRED on update (an empty body is rejected, not a no-op).
        const empty = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(empty.status(), 'PATCH with no title → 400 (title required)').toBe(400);
        expect(flatMessage((await empty.json()) as ValidationError)).toContain('title');
    });

    test('Flow 5: conversation title/providerId length caps bound the work-linkage payload (create + update)', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        // CREATE: title > 200 → 400 maxLength (a hostile work-title can't bloat the row).
        const longTitle = 'z'.repeat(250);
        const badCreate = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: longTitle },
        });
        expect(badCreate.status(), 'create title>200 → 400').toBe(400);
        expect(flatMessage((await badCreate.json()) as ValidationError)).toContain('200');

        // CREATE: providerId > 100 → 400 maxLength.
        const badProvider = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { providerId: 'p'.repeat(150) },
        });
        expect(badProvider.status(), 'create providerId>100 → 400').toBe(400);
        expect(flatMessage((await badProvider.json()) as ValidationError)).toContain('providerId');

        // A work-title at the cap boundary (<=200) is accepted — the linkage
        // convention fits comfortably within the cap.
        const conv = await createWorkConversation(request, token, fakeWorkId(6));
        expect(
            conv.title?.length,
            'a work:<uuid> title fits within the 200 cap',
        ).toBeLessThanOrEqual(200);

        // UPDATE: title > 200 → 400 maxLength (same cap on the re-scope path).
        const badPatch = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: { title: longTitle },
        });
        expect(badPatch.status(), 'PATCH title>200 → 400').toBe(400);
        expect(flatMessage((await badPatch.json()) as ValidationError)).toContain('200');
    });

    test('Flow 6: conversation `:id` is a UUID param — a non-uuid id is a 400 on every conversation route (not a 404 fall-through)', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const headers = authedHeaders(token);
        const badId = 'work-3243cd52-not-a-uuid';

        // GET / PATCH / append / DELETE all run the ParseUUIDPipe FIRST, so a
        // malformed (e.g. work-prefixed) id is a 400 validation error, never a
        // 404 — the UUID gate sits ahead of the ownership lookup.
        const get = await request.get(`${API_BASE}/api/conversations/${badId}`, { headers });
        expect(get.status(), 'GET non-uuid id → 400').toBe(400);
        expect(
            flatMessage((await get.json()) as ValidationError),
            'uuid validation message',
        ).toContain('uuid');

        const patch = await request.patch(`${API_BASE}/api/conversations/${badId}`, {
            headers,
            data: { title: 'x' },
        });
        expect(patch.status(), 'PATCH non-uuid id → 400').toBe(400);

        const append = await request.post(`${API_BASE}/api/conversations/${badId}/messages`, {
            headers,
            data: { messages: [{ role: 'user', content: 'x' }] },
        });
        expect(append.status(), 'append non-uuid id → 400').toBe(400);

        const del = await request.delete(`${API_BASE}/api/conversations/${badId}`, { headers });
        expect(del.status(), 'DELETE non-uuid id → 400').toBe(400);
    });

    test('Flow 7: cross-user MUTATION isolation — a work-conversation is 404 to another user on PATCH, append, AND delete (not only GET)', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const owner = await registerUserViaAPI(request);
        const attacker = await registerUserViaAPI(request);
        expect(owner.access_token).toHaveLength(32);
        expect(attacker.access_token).toHaveLength(32);

        const wid = fakeWorkId(7);
        const conv = await createWorkConversation(request, owner.access_token, wid);
        const attackerHeaders = authedHeaders(attacker.access_token);

        // The siblings pin the cross-user GET 404. Here we pin every MUTATING
        // verb — the user-scoped repository lookup returns null for a non-owner,
        // so each route throws NotFound BEFORE mutating anything.
        const patch = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: attackerHeaders,
            data: { title: 'hijacked' },
        });
        expect(patch.status(), 'cross-user PATCH → 404').toBe(404);

        const append = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: attackerHeaders,
            data: { messages: [{ role: 'user', content: 'hijack' }] },
        });
        expect(append.status(), 'cross-user append → 404').toBe(404);

        const del = await request.delete(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: attackerHeaders,
        });
        expect(del.status(), 'cross-user DELETE → 404').toBe(404);

        // The owner's conversation is UNTOUCHED by every rejected attempt:
        // same title, no hijacked message leaked in.
        const ownerGet = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerGet.status(), 'owner still reads the conversation → 200').toBe(200);
        const fetched = (await ownerGet.json()) as ConversationRow;
        expect(fetched.title, 'owner title unchanged by the failed hijack').toBe(`work:${wid}`);
        expect(
            fetched.messages?.some((m) => m.content === 'hijack'),
            'no attacker message leaked into the owner conversation',
        ).toBeFalsy();
    });

    test('Flow 8: per-conversation message isolation across two works owned by the SAME user', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const widA = fakeWorkId(8);
        const widB = fakeWorkId(9);
        const convA = await createWorkConversation(request, token, widA);
        const convB = await createWorkConversation(request, token, widB);
        expect(convA.id).not.toBe(convB.id);

        // Append a distinctive message ONLY to the work-A conversation.
        const marker = `scoped-msg-${suffix()}`;
        const append = await request.post(`${API_BASE}/api/conversations/${convA.id}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: marker }] },
        });
        expect(append.status()).toBe(201);

        // Work-A conversation contains it …
        const getA = await request.get(`${API_BASE}/api/conversations/${convA.id}`, {
            headers: authedHeaders(token),
        });
        const fetchedA = (await getA.json()) as ConversationRow;
        expect(
            fetchedA.messages?.some((m) => m.content === marker),
            'work-A conversation contains its own message',
        ).toBeTruthy();

        // … work-B conversation (same user, different work) does NOT — the message
        // is bound to the conversation, never bled across works.
        const getB = await request.get(`${API_BASE}/api/conversations/${convB.id}`, {
            headers: authedHeaders(token),
        });
        const fetchedB = (await getB.json()) as ConversationRow;
        expect(
            fetchedB.messages?.some((m) => m.content === marker),
            'work-B conversation is isolated — never sees work-A’s message',
        ).toBeFalsy();
    });

    test('Flow 9: empty message append on a work-conversation is well-behaved (201) and preserves the work title (no auto-title from an empty batch)', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const wid = fakeWorkId(10);
        const conv = await createWorkConversation(request, token, wid);

        // An empty messages batch is accepted (201 {success:true}) and is a no-op
        // for the title — there is no first user message to derive from, and the
        // work title is already set, so the linkage is untouched.
        const empty = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [] },
        });
        expect(empty.status(), 'empty append → 201').toBe(201);
        expect((await empty.json()).success).toBe(true);

        const get = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        const fetched = (await get.json()) as ConversationRow;
        expect(fetched.title, 'work title preserved after an empty append').toBe(`work:${wid}`);
        expect(
            Array.isArray(fetched.messages) && fetched.messages.length,
            'no phantom messages created by the empty batch',
        ).toBe(0);
    });

    test('Flow 10: DELETE lifecycle on a work-conversation — 204, then idempotent 404, and the work linkage disappears from the list', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const wid = fakeWorkId(11);
        const conv = await createWorkConversation(request, token, wid);

        // The work-conversation is present in the list before deletion.
        const before = await listConversations(request, token);
        expect(
            before.conversations.map((c) => c.id),
            'work-conversation present before delete',
        ).toContain(conv.id);

        // DELETE → 204.
        const del = await request.delete(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), 'DELETE existing work-conversation → 204').toBe(204);

        // GET after delete → 404; the work association is gone from the list.
        const getAfter = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(getAfter.status(), 'GET after delete → 404').toBe(404);

        const after = await listConversations(request, token);
        expect(
            after.conversations.map((c) => c.id),
            'work-conversation absent from the list after delete',
        ).not.toContain(conv.id);
        expect(
            after.conversations.filter((c) => (c.title ?? '').startsWith(`work:${wid}`)),
            'no conversation remains scoped to the deleted work association',
        ).toEqual([]);

        // Re-DELETE the now-gone conversation → 404 (the delete is idempotent at
        // the not-found boundary, not a 204).
        const reDelete = await request.delete(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(reDelete.status(), 're-DELETE a gone conversation → 404').toBe(404);

        // DELETE a never-existed (but valid-uuid) conversation → 404.
        const ghost = await request.delete(
            `${API_BASE}/api/conversations/00000000-0000-0000-0000-000000000000`,
            { headers: authedHeaders(token) },
        );
        expect(ghost.status(), 'DELETE a nonexistent conversation → 404').toBe(404);
    });

    test('Flow 11: list paging clamps a hostile limit for work-conversation history (DoS cap), offset paging stays consistent', async ({
        request,
    }) => {
        test.setTimeout(90_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        // Seed a handful of work-conversations so paging is observable.
        const wid = fakeWorkId(12);
        const created: string[] = [];
        for (let i = 0; i < 5; i++) {
            const conv = await createWorkConversation(request, token, wid, `:${i}`);
            created.push(conv.id);
        }
        expect(created.length).toBe(5);

        // A hostile `?limit=1000000` is clamped (DoS protection on the shared DB)
        // — the route still returns 200 with a bounded page, never a 5xx/timeout.
        const hostile = await request.get(`${API_BASE}/api/conversations?limit=1000000`, {
            headers: authedHeaders(token),
        });
        expect(hostile.status(), 'hostile limit → still 200 (clamped, not rejected)').toBe(200);
        const hostileBody = (await hostile.json()) as ConversationList;
        expect(
            hostileBody.conversations.length,
            'hostile limit is clamped to the 200 page cap',
        ).toBeLessThanOrEqual(200);

        // offset paging: page 1 (limit=2) then page 2 (limit=2, offset=2) yield
        // DISJOINT id sets — a stable, work-scoped history pagination.
        const page1 = await listConversations(request, token, 'limit=2&offset=0');
        const page2 = await listConversations(request, token, 'limit=2&offset=2');
        expect(page1.conversations.length, 'page 1 honours limit=2').toBeLessThanOrEqual(2);
        expect(page2.conversations.length, 'page 2 honours limit=2').toBeLessThanOrEqual(2);
        const page1Ids = new Set(page1.conversations.map((c) => c.id));
        const overlap = page2.conversations.filter((c) => page1Ids.has(c.id));
        expect(overlap, 'offset paging yields disjoint pages (no row repeats)').toEqual([]);

        // total reflects at least the rows we created (tolerates pre-existing rows).
        expect(page1.total, 'total counts our seeded work-conversations').toBeGreaterThanOrEqual(5);
    });

    test('Flow 12: a work-association title round-trips byte-for-byte through create → GET → list (the linkage is not normalised away)', async ({
        request,
    }) => {
        test.setTimeout(60_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        // A work title carrying the full `work:<uuid>:<label>` convention with a
        // human label — the kind the chat history sidebar shows for a work chat.
        const wid = fakeWorkId(13);
        const label = `Landing page ${suffix()}`;
        const fullTitle = `work:${wid}:${label}`;
        const create = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: fullTitle, providerId: 'openrouter' },
        });
        expect(create.status(), 'create labelled work-conversation → 201').toBe(201);
        const conv = (await create.json()) as ConversationRow;
        expect(conv.title, 'create echoes the exact work title').toBe(fullTitle);
        expect(conv.providerId, 'providerId persists alongside the work title').toBe('openrouter');

        // GET round-trips the exact title (the work id is recoverable verbatim).
        const get = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        const fetched = (await get.json()) as ConversationRow;
        expect(fetched.title, 'GET round-trips the work title byte-for-byte').toBe(fullTitle);

        // The recoverable work id (the durable linkage) is parseable from the title.
        const recoveredWorkId = (fetched.title ?? '').replace(/^work:/, '').split(':')[0];
        expect(recoveredWorkId, 'the work id is recoverable from the title linkage').toBe(wid);

        // And the list projection carries the same title (used by the history UI).
        const list = await listConversations(request, token);
        const listed = list.conversations.find((c) => c.id === conv.id);
        expect(listed?.title, 'list projection round-trips the work title').toBe(fullTitle);
        expect(listed?.providerId, 'list projection carries providerId').toBe('openrouter');
    });
});

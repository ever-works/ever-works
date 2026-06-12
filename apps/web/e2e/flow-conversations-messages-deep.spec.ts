import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Conversation MESSAGES — DEEP append/list contract coverage.
 *
 * Source of truth: apps/api/src/ai-conversation/conversation.controller.ts
 * (mounted under @Controller('api/conversations')), the appendMessages handler
 * + the ConversationMessage entity (packages/agent/src/entities/). EVERY status
 * and shape below was PROBED live against http://127.0.0.1:3100 before any
 * assertion was written.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────────
 * Two sibling specs already own the HAPPY-PATH message surface and are NOT
 * repeated here:
 *   - flow-chat-conversation-lifecycle.spec.ts → multi-batch append ordering,
 *     auto-title-from-first-user (verbatim <=60 + 80-char→57+'...'), cross-user
 *     conversation GET/DELETE 404, full create→…→delete lifecycle.
 *   - flow-conversation-crud-deep.spec.ts → auto-title BOUNDARY battery (exactly
 *     60 / 61), whitespace-collapse, system-skip, preset-no-overwrite, the
 *     four-role + parts/model/usage round-trip, empty-array 201 no-op, bulk
 *     delete-all, pagination of the conversation LIST, the missing-id 404 matrix.
 *   (flow-task-chat-messages.spec.ts covers the UNRELATED /api/tasks/:id/chat
 *    collaboration controller — a different entity with its own DTO validation.)
 *
 * This file pins the GAPS those leave un-asserted — the message endpoint's
 * (notably ABSENT) input validation, the size/pagination contracts, the message
 * DTO completeness, and the empty-vs-whitespace title boundary:
 *
 * ── PROBED CONTRACTS (live, as a throwaway user) ─────────────────────────────
 *  POST /api/conversations/:id/messages  → 201 { success: true }  (NestJS @Post
 *      default; the body is { messages: [{ role, content, parts?, model?, usage? }] }).
 *      The handler does NO class-validator DTO validation — it directly maps the
 *      array. Malformed input therefore throws an unmapped Error → HTTP 500
 *      (NOT a 400). Verified zero-persist 500s (the throw precedes any insert): a
 *      message missing `role`; missing `content`; a `messages` value that is not
 *      an array; a `messages` element that is a bare string; an entirely missing
 *      `messages` key. The batch is NOT transaction-wrapped, so a malformed
 *      element AFTER a valid one (or a numeric `content`, which 500s only after
 *      being coerced+inserted) leaves the leading/coerced row persisted. These
 *      tests assert the hard-reject is >=400 (today exactly 500) AND pin the
 *      persist outcome — so a future DTO hardening to 400/422 keeps them green
 *      (the established tolerance pattern from flow-task-chat-messages.spec.ts).
 *  Accepted-but-loose inputs (NO enum / NO size cap, unlike task-chat's
 *      16384 @MaxLength): an arbitrary role string ("wizard") → 201 + persisted;
 *      an empty-string content → 201 + persisted; a 500_000-char content → 201 +
 *      persisted in full (title still truncates to 60). Unknown extra keys on a
 *      message element are STRIPPED (only modeled columns persist) and a
 *      client-supplied `id` is IGNORED (server assigns its own).
 *  Auto-title empty-vs-whitespace boundary (the branch the CRUD-deep battery
 *      does not reach): a first USER message whose content is "" (FALSY) leaves
 *      the title NULL; a first USER message that is whitespace-only (TRUTHY, then
 *      /\s+/g→' '+trim collapses to "") sets the title to the empty string "".
 *  GET /api/conversations/:id → full row + messages[] (ASC by createdAt). The
 *      embedded message list is NOT paginated — ?limit/?offset are ignored and
 *      the FULL thread is always returned. Each message DTO carries:
 *      { id, conversationId, role, content, parts, model, usage, tenantId,
 *        organizationId, createdAt }.
 *  Ownership: a foreign user's append → 404 PRE-persist (the owner's thread is
 *      untouched); a foreign GET → 404; the conversation LIST summary never
 *      embeds a `messages` key. The persistence path needs NO AI provider key
 *      (it just stores rows) — it never 5xx-stacktraces for a keyless env, and a
 *      user message always persists regardless of provider configuration.
 *  Auth: append with no bearer token → 401.
 */

interface ConversationRow {
    id: string;
    userId: string;
    title: string | null;
    providerId: string | null;
    model: string | null;
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

// A uuid no row can own — drives the missing/foreign-id 404 checks.
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

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

async function getConversation(
    request: APIRequestContext,
    token: string,
    id: string,
    query = '',
): Promise<{ status: number; row: ConversationRow | null }> {
    const res = await request.get(`${API_BASE}/api/conversations/${id}${query}`, {
        headers: authedHeaders(token),
    });
    const row = res.ok() ? ((await res.json()) as ConversationRow) : null;
    return { status: res.status(), row };
}

/** Raw append: returns the status + parsed body so tests can probe the 500/201 + shape. */
async function appendRaw(
    request: APIRequestContext,
    token: string,
    id: string,
    body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/conversations/${id}/messages`, {
        headers: authedHeaders(token),
        data: body as Record<string, unknown>,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status(), json };
}

test.describe('Conversation messages deep — append input validation (no DTO → hard-reject, never persist)', () => {
    test('malformed append bodies are hard-rejected (>=400, today 500) and persist nothing', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // Each of these malformed shapes trips the un-validated handler. The
        // controller has no class-validator DTO, so an unmapped Error surfaces as
        // a 500 today; tolerate a future hardening to 400/422. The invariant that
        // must hold in EVERY case here: a hard-reject (>=400) and — because the
        // throw happens BEFORE any insert for these shapes — NO row persisted.
        // (NB: a NUMERIC content value is deliberately excluded from this
        // zero-persist battery: it ALSO 500s, but only AFTER the number has been
        // coerced+inserted as a string, so it is a partial-persist case — that
        // non-atomic write is pinned by the mixed-batch test below instead.)
        const malformed: Array<{ label: string; body: unknown }> = [
            { label: 'message missing role', body: { messages: [{ content: 'no role here' }] } },
            { label: 'message missing content', body: { messages: [{ role: 'user' }] } },
            { label: 'messages is not an array', body: { messages: 'hello' } },
            { label: 'messages element is a bare string', body: { messages: ['just a string'] } },
            { label: 'messages key missing entirely', body: {} },
        ];

        for (const { label, body } of malformed) {
            const { status } = await appendRaw(request, token, conv.id, body);
            expect(status, `${label} → hard-reject`).toBeGreaterThanOrEqual(400);
            expect([400, 422, 500], `${label} → 400/422/500 (no 2xx, no other 5xx)`).toContain(
                status,
            );
        }

        // After the whole malformed battery the conversation is still empty and
        // untitled — not a single bad message leaked into the thread.
        const after = await getConversation(request, token, conv.id);
        expect(after.status, 'conversation still readable').toBe(200);
        expect(after.row?.messages, 'no malformed message persisted').toHaveLength(0);
        expect(after.row?.title, 'no malformed message set a title').toBeNull();
    });

    test('append accepts loose inputs the DTO-less handler does not police: arbitrary role + empty content persist', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // Unlike the task-chat controller (role enum + 16384 @MaxLength), this
        // endpoint persists an arbitrary role string and an empty content body.
        const { status, json } = await appendRaw(request, token, conv.id, {
            messages: [
                { role: 'wizard', content: 'magic incantation' },
                { role: 'user', content: '' },
            ],
        });
        expect(status, 'loose roles/content → 201').toBe(201);
        expect(json, 'append response shape is exactly { success: true }').toEqual({
            success: true,
        });

        const after = await getConversation(request, token, conv.id);
        const msgs = after.row?.messages ?? [];
        expect(msgs, 'both loose messages persisted in order').toHaveLength(2);
        expect(
            msgs.map((m) => m.role),
            'arbitrary role stored verbatim (no enum)',
        ).toEqual(['wizard', 'user']);
        expect(msgs[1].content, 'empty-string content stored verbatim').toBe('');
    });

    test('a mixed batch (valid message followed by a malformed one) hard-rejects without crashing the conversation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // The batch is mapped element-by-element with no surrounding transaction,
        // so a trailing malformed element throws AFTER the leading valid one is
        // already written. Pin the OBSERVABLE invariants rather than the exact
        // persist count: the call hard-rejects (>=400, today 500) and the
        // conversation stays readable (no corruption / no 5xx on the follow-up GET).
        const { status } = await appendRaw(request, token, conv.id, {
            messages: [{ role: 'user', content: 'good one' }, { role: 'user' /* no content */ }],
        });
        expect(status, 'mixed valid+malformed batch → hard-reject').toBeGreaterThanOrEqual(400);
        expect([400, 422, 500]).toContain(status);

        const after = await getConversation(request, token, conv.id);
        expect(after.status, 'conversation still readable after a partial batch').toBe(200);
        const msgs = after.row?.messages ?? [];
        // Today the leading valid message persists (count 1 — the batch is NOT
        // atomic). A future transactional fix would roll it back (count 0). Both
        // are acceptable; what must hold is that the MALFORMED message never
        // landed and the thread is not corrupted.
        expect(msgs.length, 'at most the one leading valid message persisted').toBeLessThanOrEqual(
            1,
        );
        expect(
            msgs.every((m) => typeof m.content === 'string' && m.content.length > 0),
            'no malformed (content-less) message leaked into the thread',
        ).toBe(true);
    });

    test('append requires a bearer token (401)', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // Raw context with NO cookies / NO bearer — independent of any
        // storageState the shared `request` fixture might carry.
        const anon = await pwRequest.newContext();
        try {
            const res = await anon.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
                data: { messages: [{ role: 'user', content: 'anon append' }] },
            });
            expect(res.status(), 'unauthenticated append → 401').toBe(401);
        } finally {
            await anon.dispose();
        }

        // The unauthenticated attempt persisted nothing.
        const after = await getConversation(request, token, conv.id);
        expect(after.row?.messages, 'anon append did not persist').toHaveLength(0);
    });
});

test.describe('Conversation messages deep — size + pagination contracts', () => {
    test('message content has NO size cap: a 500k-char body persists in full and still titles to 60', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // 500_000 chars — far past task-chat's 16384 ceiling. The conversation
        // message endpoint imposes no @MaxLength, so this is accepted and stored
        // verbatim. (Kept at 500k, not megabytes, to stay well under the JSON
        // body limit while still proving "no cap at the DTO layer".)
        const huge = 'Z'.repeat(500_000);
        const { status } = await appendRaw(request, token, conv.id, {
            messages: [{ role: 'user', content: huge }],
        });
        expect(status, 'oversize content → 201 (no cap)').toBe(201);

        const after = await getConversation(request, token, conv.id);
        const msgs = after.row?.messages ?? [];
        expect(msgs, 'oversize message persisted').toHaveLength(1);
        expect(msgs[0].content.length, 'content stored in full, untruncated').toBe(500_000);
        // The auto-title still truncates to the 60-char (57 + '...') window even
        // though the message body itself is never truncated.
        expect(after.row?.title?.length, 'title truncated to 60 regardless of body size').toBe(60);
        expect(after.row?.title?.endsWith('...'), 'truncated title carries the ellipsis').toBe(
            true,
        );
    });

    test('the embedded message list is NOT paginated: ?limit/?offset are ignored and the full thread returns', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // Seed a 3-message thread.
        expect(
            (
                await appendRaw(request, token, conv.id, {
                    messages: [
                        { role: 'user', content: 'm1' },
                        { role: 'assistant', content: 'm2' },
                        { role: 'user', content: 'm3' },
                    ],
                })
            ).status,
            'seed thread → 201',
        ).toBe(201);

        // The default GET returns all three, ASC by createdAt.
        const full = await getConversation(request, token, conv.id);
        expect(
            full.row?.messages?.map((m) => m.content),
            'full thread in append order',
        ).toEqual(['m1', 'm2', 'm3']);

        // ?limit=1 and ?offset=2 are NOT honored on the embedded message list
        // (the conversation FIND has no message-level windowing) — the full
        // thread comes back unchanged in BOTH cases.
        const limited = await getConversation(request, token, conv.id, '?limit=1');
        expect(limited.row?.messages, '?limit=1 ignored → all 3 messages').toHaveLength(3);
        const offset = await getConversation(request, token, conv.id, '?limit=1&offset=2');
        expect(offset.row?.messages, '?offset ignored → all 3 messages').toHaveLength(3);
        expect(
            offset.row?.messages?.map((m) => m.content),
            'still the full ordered thread',
        ).toEqual(['m1', 'm2', 'm3']);
    });
});

test.describe('Conversation messages deep — keyless persistence (provider-agnostic)', () => {
    test('the message-append path stores user AND assistant turns verbatim without ever touching an AI provider', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // This endpoint only PERSISTS the transcript the client sends — it never
        // calls a model. So in the keyless CI env (no PLUGIN_OPENROUTER_API_KEY)
        // an assistant turn supplied by the caller is stored exactly as sent, the
        // call is a clean 201, and there is no 5xx-stacktrace dependence on
        // provider configuration. (The actual model round-trip lives behind
        // /api/chat — covered by the chat specs — not here.)
        const userTurn = `keyless probe ${Date.now().toString(36)}: what is the deploy step?`;
        const assistantTurn = 'Open Plugins and enable a deployment plugin, then run a deploy.';
        const { status, json } = await appendRaw(request, token, conv.id, {
            messages: [
                { role: 'user', content: userTurn },
                { role: 'assistant', content: assistantTurn, model: 'caller-supplied-model' },
            ],
        });
        expect(status, 'keyless append → 201 (no provider needed)').toBe(201);
        expect(json, 'clean { success: true }, never a provider error envelope').toEqual({
            success: true,
        });

        const after = await getConversation(request, token, conv.id);
        const msgs = after.row?.messages ?? [];
        expect(
            msgs.map((m) => m.role),
            'both roles persisted in order',
        ).toEqual(['user', 'assistant']);
        expect(msgs[0].content, 'user turn stored verbatim').toBe(userTurn);
        expect(msgs[1].content, 'caller-supplied assistant turn stored verbatim').toBe(
            assistantTurn,
        );
        // The first user message titled the conversation — the persistence side of
        // the flow is fully functional with no key present.
        expect(after.row?.title, 'first user message titled the conversation keylessly').toBe(
            userTurn,
        );
    });
});

test.describe('Conversation messages deep — message DTO completeness + id provenance', () => {
    test('persisted message DTO is server-shaped: client id ignored, unknown keys stripped, parts/usage/scope columns present', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, {});

        // Send a message with a client-supplied id, an unknown field, and the
        // optional parts/model/usage. The server must assign its OWN id, drop the
        // unknown key, and round-trip the modeled optional columns.
        const parts = [{ type: 'text', text: 'structured' }];
        const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
        const { status } = await appendRaw(request, token, conv.id, {
            messages: [
                {
                    id: 'client-supplied-id',
                    role: 'assistant',
                    content: 'dto probe',
                    parts,
                    model: 'gpt-4o-mini',
                    usage,
                    bogusField: 'should be stripped',
                },
            ],
        });
        expect(status, 'dto probe append → 201').toBe(201);

        const after = await getConversation(request, token, conv.id);
        const msg = after.row?.messages?.[0];
        expect(msg, 'message persisted').toBeTruthy();

        // The server assigns its own id (the client-supplied one is never trusted).
        expect(msg?.id, 'server-assigned id, NOT the client one').not.toBe('client-supplied-id');
        expect(msg?.id, 'server id is present').toBeTruthy();
        expect(msg?.conversationId, 'message points back at its conversation').toBe(conv.id);

        // The unknown field never round-trips (only modeled columns persist).
        const asRecord = msg as unknown as Record<string, unknown>;
        expect('bogusField' in asRecord, 'unknown key stripped from the persisted DTO').toBe(false);

        // The modeled optional columns round-trip verbatim.
        expect(msg?.parts, 'parts round-trip').toEqual(parts);
        expect(msg?.model, 'model round-trip').toBe('gpt-4o-mini');
        expect(msg?.usage, 'usage round-trip').toEqual(usage);

        // The scope columns are present on the message DTO (null for a personal,
        // non-org conversation — the field exists, it is simply unset here).
        expect('tenantId' in asRecord, 'message DTO carries tenantId').toBe(true);
        expect('organizationId' in asRecord, 'message DTO carries organizationId').toBe(true);
        expect(asRecord.tenantId, 'personal conversation has no tenant scope').toBeNull();
        expect(asRecord.organizationId, 'personal conversation has no org scope').toBeNull();
    });
});

test.describe('Conversation messages deep — auto-title empty-vs-whitespace boundary', () => {
    test('empty-string first-user content leaves the title NULL; whitespace-only sets it to the empty string', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // (a) Content is "" — FALSY, so the `if (firstUser?.content)` title guard
        //     never fires: the conversation stays untitled (null), even though the
        //     empty message itself is persisted.
        const cEmpty = await createConversation(request, token, {});
        expect(
            (
                await appendRaw(request, token, cEmpty.id, {
                    messages: [{ role: 'user', content: '' }],
                })
            ).status,
            'empty-content append → 201',
        ).toBe(201);
        const emptyRow = await getConversation(request, token, cEmpty.id);
        expect(emptyRow.row?.messages, 'empty message persisted').toHaveLength(1);
        expect(emptyRow.row?.title, 'empty-string content → title stays null').toBeNull();

        // (b) Content is whitespace-only — TRUTHY, so the title guard fires; the
        //     /\s+/g→' ' + trim() normalization then collapses it to the EMPTY
        //     STRING. The distinction from (a) is the title TYPE: "" (set), not
        //     null (unset).
        const cWs = await createConversation(request, token, {});
        expect(
            (
                await appendRaw(request, token, cWs.id, {
                    messages: [{ role: 'user', content: '  \t \n ' }],
                })
            ).status,
            'whitespace-content append → 201',
        ).toBe(201);
        const wsRow = await getConversation(request, token, cWs.id);
        expect(wsRow.row?.title, 'whitespace-only content → title is the empty string').toBe('');
        expect(wsRow.row?.title, 'and that empty string is distinct from null').not.toBeNull();
    });
});

test.describe('Conversation messages deep — cross-user isolation (append/list/leak)', () => {
    test("a foreign append is 404 pre-persist; the owner's thread is untouched and never leaks via list", async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);

        // Alice owns a conversation with one private message.
        const conv = await createConversation(request, alice.access_token, {
            title: `alice secret ${stamp}`,
        });
        expect(
            (
                await appendRaw(request, alice.access_token, conv.id, {
                    messages: [{ role: 'user', content: 'alice private msg' }],
                })
            ).status,
            'alice seed → 201',
        ).toBe(201);

        // Bob cannot append to Alice's conversation — the ownership gate (same
        // findById(id, userId)) 404s BEFORE any message is written.
        const bobAppend = await appendRaw(request, bob.access_token, conv.id, {
            messages: [{ role: 'user', content: 'bob intrusion' }],
        });
        expect(bobAppend.status, "B cannot append to A's conversation → 404").toBe(404);

        // Bob cannot read Alice's thread either.
        const bobGet = await getConversation(request, bob.access_token, conv.id);
        expect(bobGet.status, "B cannot GET A's conversation → 404").toBe(404);

        // Alice's thread is exactly her one message — Bob's rejected append never
        // landed (the 404 is pre-persist).
        const aliceView = await getConversation(request, alice.access_token, conv.id);
        expect(
            aliceView.row?.messages?.map((m) => m.content),
            'only the owner message survives',
        ).toEqual(['alice private msg']);

        // The conversation LIST summary projection never embeds the messages
        // array (heavy fields are excluded from findByUser) — so message content
        // cannot leak through the list endpoint.
        const listRes = await request.get(`${API_BASE}/api/conversations?limit=50&offset=0`, {
            headers: authedHeaders(alice.access_token),
        });
        expect(listRes.status(), 'list → 200').toBe(200);
        const list = (await listRes.json()) as {
            conversations: Array<Record<string, unknown>>;
        };
        const summary = list.conversations.find((c) => c.id === conv.id);
        expect(summary, 'conversation appears in the owner list').toBeTruthy();
        expect('messages' in (summary ?? {}), 'list summary never embeds the messages array').toBe(
            false,
        );
    });

    test('append to a non-existent conversation id is a truthful 404 (not 401/500)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A well-formed body against a uuid that does not exist → 404 (existence/
        // ownership is checked before the body is processed).
        const res = await appendRaw(request, token, MISSING_ID, {
            messages: [{ role: 'user', content: 'anyone home?' }],
        });
        expect(res.status, 'append to a missing conversation → 404').toBe(404);
    });

    test('append to a just-DELETED conversation is a truthful 404 (existence re-checked per call)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Create, populate, then delete — the row (and its messages) are gone.
        const conv = await createConversation(request, token, {});
        expect(
            (
                await appendRaw(request, token, conv.id, {
                    messages: [{ role: 'user', content: 'before the purge' }],
                })
            ).status,
            'seed → 201',
        ).toBe(201);
        const del = await request.delete(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), 'delete → 204').toBe(204);

        // Appending to the now-deleted id 404s (the handler re-resolves the
        // conversation each call — a stale client id cannot resurrect it).
        const ghost = await appendRaw(request, token, conv.id, {
            messages: [{ role: 'user', content: 'ghost write' }],
        });
        expect(ghost.status, 'append after delete → 404').toBe(404);

        // And the conversation truly does not come back.
        const gone = await getConversation(request, token, conv.id);
        expect(gone.status, 'GET after delete → 404').toBe(404);
    });
});

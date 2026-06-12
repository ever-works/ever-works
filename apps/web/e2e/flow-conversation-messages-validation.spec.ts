import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Conversation MESSAGES — append-contract VALIDATION top-up.
 *
 * Source of truth: apps/api/src/ai-conversation/conversation.controller.ts
 * (mounted under @Controller('api/conversations')), the appendMessages handler.
 * That handler has NO class-validator DTO: it maps the supplied array straight
 * onto ConversationMessage rows, so malformed shapes throw an UNMAPPED Error
 * and surface as HTTP 500 today — and because the batch is NOT transaction
 * wrapped, a value that throws only AFTER a string-coercion+insert leaves a
 * partial row behind. EVERY status/shape below was PROBED live against
 * http://127.0.0.1:3100 before any assertion was written.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────────
 * Three sibling specs already own the surfaces below and are NOT repeated here:
 *   - flow-conversations-messages-deep.spec.ts → the FIRST malformed matrix
 *     (missing role, missing content, non-array messages, bare-string element,
 *     missing messages key) + loose roles/empty-content + mixed valid/malformed
 *     partial-persist + 401 no-token + the 500_000-char (UNDER the body limit)
 *     oversize case + no-pagination + keyless persistence + the DTO completeness
 *     round-trip + the empty-vs-whitespace title boundary + cross-user
 *     append/list 404 + missing-id 404 + deleted-id 404.
 *   - flow-chat-conversation-lifecycle.spec.ts → CROSS-batch append ordering
 *     (createdAt ASC across two separate POSTs) + the long-first-user 60-char
 *     title + cross-user GET/DELETE 404.
 *   - flow-conversation(s)-crud-deep.spec.ts → auto-title 60/61 boundary,
 *     whitespace-collapse, system-skip, preset-no-overwrite, empty-array 201
 *     no-op, conversation-LIST pagination, the missing-id 404 matrix.
 *
 * This file pins the GAPS those leave un-asserted — all live-probed:
 *
 * ── PROBED CONTRACTS (live, as throwaway users) ──────────────────────────────
 *  WRONG-TYPE matrix (beyond the deep spec's missing-key matrix). The handler
 *      does NOT type-check field VALUES, so behaviour splits three ways:
 *        • role = number (123)  → 201, persisted with role COERCED to "123"
 *          (a non-string role is silently accepted, like the deep spec's
 *          arbitrary "wizard" string — there is no enum AND no string guard).
 *        • role = null / role = object → 500 + ZERO persist (throws before any
 *          insert for this element).
 *        • content = number (42) / content = boolean (true) → 500 but PARTIAL
 *          persist: the value is string-coerced+inserted ("42" / "1.0") and the
 *          throw happens after, so one row leaks (the non-atomic write).
 *        • content = array / content = object / content = null → 500 + ZERO
 *          persist.
 *      Each asserts a TOLERANT hard-reject [400,422,500] (survives a future DTO
 *      fix to 400/422) AND the exact per-shape persist count, so the
 *      non-atomic-write contract is pinned today and the zero-persist invariant
 *      survives a future transactional fix.
 *  SINGLE-BATCH ordering: a 5-message interleaved (user/assistant) batch sent in
 *      ONE POST lands in array order (the deep + lifecycle specs pin CROSS-batch
 *      ordering only; neither pins a single >2-element batch's internal order).
 *  Title from a LATER batch: an assistant-only first batch leaves the title NULL
 *      (no user message yet); a user message arriving in a SUBSEQUENT batch then
 *      sets the title — the title is computed against the first USER message
 *      whenever it lands, not only on the first append.
 *  Body-size 413 boundary: a ~2MB content body is rejected by the JSON body
 *      parser with 413 (request entity too large) and persists NOTHING — the
 *      hard ceiling ABOVE the deep spec's accepted 500k case.
 *  Title truncates a 200-char single-line first message to 60 (57 + '...') while
 *      the message BODY persists in full (untruncated) — the truncate-title /
 *      keep-body invariant at a mid-size value.
 *  Param validation: a non-UUID :id is rejected by ParseUUIDPipe with 400
 *      ("Validation failed (uuid is expected)") — distinct from the well-formed
 *      but non-existent uuid's 404 (owned by the deep spec).
 */

interface ConversationRow {
    id: string;
    userId: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
    messages?: ConversationMessage[];
}

interface ConversationMessage {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    createdAt: string;
}

// Tolerant hard-reject set: 500 today (no DTO), 400/422 after a future fix.
const HARD_REJECT = [400, 422, 500];

async function createConversation(
    request: APIRequestContext,
    token: string,
): Promise<ConversationRow> {
    const res = await request.post(`${API_BASE}/api/conversations`, {
        headers: authedHeaders(token),
        data: {},
    });
    expect(res.status(), 'create conversation → 201').toBe(201);
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

/** Raw append: returns status + parsed body so tests can probe the 500/201/413 + shape. */
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

test.describe('Conversation messages validation — wrong-type field matrix (no DTO → split behaviour)', () => {
    // Shapes that ACCEPT (the value is coerced and persisted, 201). A non-string
    // role is silently stored — there is no enum and no string guard on role.
    test('a numeric role is silently coerced and persisted (201) — no role type guard', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token);

        const { status, json } = await appendRaw(request, token, conv.id, {
            messages: [{ role: 123, content: 'numeric role body' }],
        });
        expect(status, 'numeric role → 201 (coerced, not rejected)').toBe(201);
        expect(json, 'response is exactly { success: true }').toEqual({ success: true });

        const after = await getConversation(request, token, conv.id);
        const msgs = after.row?.messages ?? [];
        expect(msgs, 'the coerced-role message persisted').toHaveLength(1);
        // The number is string-coerced on the way into the text column.
        expect(msgs[0].role, 'numeric role stored as its string form').toBe('123');
        expect(msgs[0].content, 'content stored verbatim').toBe('numeric role body');
    });

    // Shapes that throw BEFORE any insert → hard-reject + ZERO persist. A future
    // DTO hardening flips 500→400/422 but the zero-persist invariant must hold.
    test('null / object role and array / object / null content hard-reject and persist NOTHING', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const zeroPersist: Array<{ label: string; body: unknown }> = [
            { label: 'role is null', body: { messages: [{ role: null, content: 'x' }] } },
            { label: 'role is an object', body: { messages: [{ role: { a: 1 }, content: 'x' }] } },
            {
                label: 'content is an array',
                body: { messages: [{ role: 'user', content: [1, 2] }] },
            },
            {
                label: 'content is an object',
                body: { messages: [{ role: 'user', content: { a: 1 } }] },
            },
            { label: 'content is null', body: { messages: [{ role: 'user', content: null }] } },
        ];

        for (const { label, body } of zeroPersist) {
            // Fresh conversation per shape → the persist-check is unambiguous.
            const conv = await createConversation(request, token);
            const { status } = await appendRaw(request, token, conv.id, body);
            expect(status, `${label} → hard-reject`).toBeGreaterThanOrEqual(400);
            expect(HARD_REJECT, `${label} → 400/422/500 (no 2xx, no other 5xx)`).toContain(status);

            const after = await getConversation(request, token, conv.id);
            expect(after.status, `${label}: conversation still readable`).toBe(200);
            expect(after.row?.messages, `${label}: nothing persisted`).toHaveLength(0);
            expect(after.row?.title, `${label}: no title set`).toBeNull();
        }
    });

    // Shapes that throw only AFTER a string-coercion+insert → hard-reject but a
    // PARTIAL row leaks (the batch is not transaction-wrapped). Pin the exact
    // non-atomic outcome; tolerate a future transactional fix that rolls it back.
    // The deep spec already pins `messages: 'hello'` (a STRING). These are the
    // OTHER non-array container types — each likewise throws before any insert.
    test('a non-array messages container (null / number / object) hard-rejects and persists nothing', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const nonArray: Array<{ label: string; body: unknown }> = [
            { label: 'messages is null', body: { messages: null } },
            { label: 'messages is a number', body: { messages: 123 } },
            { label: 'messages is a plain object', body: { messages: { a: 1 } } },
        ];

        for (const { label, body } of nonArray) {
            const conv = await createConversation(request, token);
            const { status } = await appendRaw(request, token, conv.id, body);
            expect(status, `${label} → hard-reject`).toBeGreaterThanOrEqual(400);
            expect(HARD_REJECT, `${label} → 400/422/500`).toContain(status);

            const after = await getConversation(request, token, conv.id);
            expect(after.status, `${label}: conversation still readable`).toBe(200);
            expect(after.row?.messages, `${label}: nothing persisted`).toHaveLength(0);
        }
    });

    test('numeric / boolean content string-coerces then 500s — a single partial row leaks (non-atomic)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const partial: Array<{ label: string; body: unknown; coerced: string }> = [
            {
                label: 'content is a number',
                body: { messages: [{ role: 'user', content: 42 }] },
                coerced: '42',
            },
            {
                label: 'content is a boolean',
                body: { messages: [{ role: 'user', content: true }] },
                coerced: '1.0',
            },
        ];

        for (const { label, body, coerced } of partial) {
            const conv = await createConversation(request, token);
            const { status } = await appendRaw(request, token, conv.id, body);
            expect(status, `${label} → hard-reject`).toBeGreaterThanOrEqual(400);
            expect(HARD_REJECT, `${label} → 400/422/500`).toContain(status);

            const after = await getConversation(request, token, conv.id);
            expect(after.status, `${label}: conversation still readable`).toBe(200);
            const msgs = after.row?.messages ?? [];
            // Today the coerced value is already inserted before the throw → 1 row.
            // A future transactional/validating fix would roll it back → 0 rows.
            // Both acceptable; the bound is "at most one, and only the coerced row".
            expect(msgs.length, `${label}: at most one partial row leaked`).toBeLessThanOrEqual(1);
            for (const m of msgs) {
                expect(m.content, `${label}: any leaked row carries the string-coerced value`).toBe(
                    coerced,
                );
            }
        }
    });
});

test.describe('Conversation messages validation — single-batch ordering', () => {
    test('a 5-message interleaved batch sent in ONE POST persists in array order', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token);

        // One POST, five interleaved turns. The handler maps the array
        // element-by-element, so the persisted order must mirror the request
        // array exactly (the deep/lifecycle specs only pin CROSS-batch order).
        const batch = [
            { role: 'user', content: 'q1' },
            { role: 'assistant', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'assistant', content: 'a2' },
            { role: 'user', content: 'q3' },
        ];
        const { status } = await appendRaw(request, token, conv.id, { messages: batch });
        expect(status, 'single 5-message batch → 201').toBe(201);

        const after = await getConversation(request, token, conv.id);
        const msgs = after.row?.messages ?? [];
        expect(
            msgs.map((m) => `${m.role}:${m.content}`),
            'persisted order mirrors the request array exactly',
        ).toEqual(['user:q1', 'assistant:a1', 'user:q2', 'assistant:a2', 'user:q3']);

        // createdAt is non-decreasing across the single batch.
        const times = msgs.map((m) => new Date(m.createdAt).getTime());
        for (let i = 1; i < times.length; i++) {
            expect(times[i], 'createdAt ASC within the batch').toBeGreaterThanOrEqual(times[i - 1]);
        }
        // The first USER message titled the conversation.
        expect(after.row?.title, 'title from the first user turn of the batch').toBe('q1');
    });

    test('a batch whose SECOND element throws leaves the leading valid row written but the title UNSET', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token);

        // Element 1 is a valid USER message; element 2 throws (role: null). The
        // loop writes element 1, then throws on element 2 BEFORE the post-loop
        // title computation runs — so the leading row survives (non-atomic) yet
        // the title is never set. This is the title-side of the non-atomic
        // contract that the deep spec's mixed-batch test does not reach.
        const { status } = await appendRaw(request, token, conv.id, {
            messages: [
                { role: 'user', content: 'leading valid' },
                { role: null, content: 'thrower' },
            ],
        });
        expect(status, 'valid-then-thrower batch → hard-reject').toBeGreaterThanOrEqual(400);
        expect(HARD_REJECT, 'valid-then-thrower → 400/422/500').toContain(status);

        const after = await getConversation(request, token, conv.id);
        expect(after.status, 'conversation still readable after a thrown batch').toBe(200);
        const msgs = after.row?.messages ?? [];
        // Today: exactly the leading valid row (count 1). A future transactional
        // fix rolls it back (count 0). Either way the THROWER never landed and
        // every surviving row is the valid leading one.
        expect(msgs.length, 'at most the leading valid row persisted').toBeLessThanOrEqual(1);
        for (const m of msgs) {
            expect(m.content, 'only the leading valid content survives').toBe('leading valid');
            expect(m.role, 'and it kept its valid role').toBe('user');
        }
        // The title computation never ran (the loop threw first) → still null,
        // even though a valid user message physically persisted.
        expect(after.row?.title, 'a thrown batch never set the title').toBeNull();
    });
});

test.describe('Conversation messages validation — title computed against the first USER message', () => {
    test('an assistant-only first batch leaves the title null; a user message in a LATER batch sets it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token);

        // Batch 1 has no user message → the title guard never fires.
        expect(
            (
                await appendRaw(request, token, conv.id, {
                    messages: [{ role: 'assistant', content: 'hi from the bot' }],
                })
            ).status,
            'assistant-only first batch → 201',
        ).toBe(201);
        const afterB1 = await getConversation(request, token, conv.id);
        expect(afterB1.row?.messages, 'assistant turn persisted').toHaveLength(1);
        expect(afterB1.row?.title, 'no user message yet → title stays null').toBeNull();

        // Batch 2 introduces the first user message → the title is set now,
        // proving the title is computed against the first USER message whenever
        // it arrives, not only on the very first append.
        expect(
            (
                await appendRaw(request, token, conv.id, {
                    messages: [{ role: 'user', content: 'now a real question' }],
                })
            ).status,
            'later user batch → 201',
        ).toBe(201);
        const afterB2 = await getConversation(request, token, conv.id);
        expect(
            afterB2.row?.messages?.map((m) => m.role),
            'both turns persisted in append order',
        ).toEqual(['assistant', 'user']);
        expect(afterB2.row?.title, 'the later user message set the title').toBe(
            'now a real question',
        );
    });
});

test.describe('Conversation messages validation — body-size 413 ceiling', () => {
    test('a ~2MB content body is rejected by the JSON body parser (413) and persists nothing', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token);

        // 2MB — above the JSON body-parser limit (the deep spec's 500k case sits
        // UNDER it and is accepted). The parser rejects before the handler runs,
        // so this is a 413 (request entity too large) with no row written.
        const huge = 'A'.repeat(2 * 1024 * 1024);
        const { status } = await appendRaw(request, token, conv.id, {
            messages: [{ role: 'user', content: huge }],
        });
        expect(status, 'oversize 2MB body → 413').toBe(413);

        const after = await getConversation(request, token, conv.id);
        expect(after.status, 'conversation still readable').toBe(200);
        expect(after.row?.messages, 'rejected oversize body persisted nothing').toHaveLength(0);
        expect(after.row?.title, 'no title from a rejected oversize body').toBeNull();
    });

    test('a 200-char single-line first message truncates the title to 60 (57 + ellipsis) but stores the body in full', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token);

        // A mid-size single-line message: comfortably under the body limit, well
        // over the 60-char title window. The title truncates; the body does not.
        const body = 'B'.repeat(200);
        expect(
            (
                await appendRaw(request, token, conv.id, {
                    messages: [{ role: 'user', content: body }],
                })
            ).status,
            '200-char append → 201',
        ).toBe(201);

        const after = await getConversation(request, token, conv.id);
        const msgs = after.row?.messages ?? [];
        expect(msgs, 'message persisted').toHaveLength(1);
        expect(msgs[0].content.length, 'body stored in full, untruncated').toBe(200);
        expect(after.row?.title?.length, 'title truncated to the 60-char window').toBe(60);
        expect(after.row?.title?.endsWith('...'), 'truncated title carries the ellipsis').toBe(
            true,
        );
    });
});

test.describe('Conversation messages validation — param + ownership rejection', () => {
    test('a non-UUID conversation :id is rejected by ParseUUIDPipe with 400 (not 404/500)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // ParseUUIDPipe runs before the handler — a syntactically invalid id is a
        // 400 ("uuid is expected"), distinct from a well-formed-but-missing uuid's
        // 404 (owned by the deep spec).
        const { status, json } = await appendRaw(request, token, 'not-a-uuid', {
            messages: [{ role: 'user', content: 'x' }],
        });
        expect(status, 'malformed :id → 400 from ParseUUIDPipe').toBe(400);
        const asRecord = json as unknown as Record<string, unknown>;
        expect(
            String(asRecord.message ?? ''),
            'the 400 names the uuid validation failure',
        ).toContain('uuid');
    });

    test('a foreign user appending a malformed body is gated by ownership (404) BEFORE any validation', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const conv = await createConversation(request, alice.access_token);

        // The ownership check (findById(id, userId)) resolves before the body is
        // touched: Bob gets a 404 even though his body is ALSO malformed (a bare
        // string element). Ownership wins over the would-be 500 — the endpoint
        // never reveals "your body is bad" to a non-owner.
        const { status } = await appendRaw(request, bob.access_token, conv.id, {
            messages: ['a malformed bare string'],
        });
        expect(status, "B's malformed append to A's conversation → 404 (ownership first)").toBe(
            404,
        );

        // Raw anon context (independent of any storageState) with a malformed body
        // is likewise an auth rejection, not a 500 — auth precedes validation.
        const anon = await pwRequest.newContext();
        try {
            const res = await anon.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
                data: { messages: ['still malformed'] },
            });
            expect(res.status(), 'anon malformed append → 401 (auth before validation)').toBe(401);
        } finally {
            await anon.dispose();
        }

        // Alice's thread was never touched by either rejected attempt.
        const after = await getConversation(request, alice.access_token, conv.id);
        expect(
            after.row?.messages,
            "owner's thread untouched by rejected foreign appends",
        ).toHaveLength(0);
    });
});

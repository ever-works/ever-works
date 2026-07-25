import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Conversation append — AppendMessageDto OPTIONAL-FIELD validation + batch-atomicity MATRIX.
 *
 * Source of truth (READ + PROBED live against http://127.0.0.1:3100 before every
 * assertion): apps/api/src/ai-conversation/conversation.controller.ts, the
 * AppendMessageDto / AppendMessagesDto class-validator metadata + the
 * appendMessages handler, and the ConversationMessage entity
 * (packages/agent/src/entities/).
 *
 * ── WHY THIS FILE (NON-DUPLICATION) ──────────────────────────────────────────
 * The sibling conversation specs already own — and this file deliberately does
 * NOT repeat — these surfaces:
 *   - flow-conversations-crud-deep.spec.ts → CreateConversationDto title(≤200) /
 *     providerId(≤100) length + @IsString + create-whitelist, UpdateConversationDto
 *     title-required PATCH matrix, the GET limit/offset DoS-clamp, ParseUUIDPipe.
 *   - flow-conversation-crud-deep.spec.ts → delete-all, pagination ordering,
 *     auto-title boundary battery, empty-array 201 no-op, the 401 + missing-id matrices.
 *   - flow-conversation-messages-validation.spec.ts / flow-conversations-messages-deep.spec.ts
 *     → the role/content wrong-type matrix (numeric/null/object role, array/object/
 *     null/number/boolean content), missing role/content, non-array `messages`
 *     container, bare-string element, single-batch ordering, 413 body ceiling,
 *     auto-title-from-first-user, the layered auth→body→ownership pipeline.
 *   - flow-ai-conversation-work-scoped.spec.ts → cross-user PATCH/append/DELETE 404.
 *
 * What NONE of them pin — and what this file exhaustively does — is the
 * AppendMessageDto's four OPTIONAL fields, the AppendMessagesDto container caps,
 * and the whole-batch atomicity the DTO now guarantees:
 *
 * ── PROBED CONTRACT (live, as throwaway users) ───────────────────────────────
 *   POST /api/conversations/:id/messages  { messages: [ AppendMessageDto ] }
 *     AppendMessageDto = { id?(@IsString,≤200), role(@IsIn user|assistant|system|tool),
 *                          content(@IsString), parts?(@IsArray), model?(@IsString,≤100),
 *                          usage?(@IsObject) }
 *     AppendMessagesDto = { messages: @IsArray @ArrayMaxSize(500) @ValidateNested({each}) }
 *
 *   • id     → over-length (201) → 400 "messages.0.id must be shorter than or equal to
 *              200 characters"; non-string → +"messages.0.id must be a string". id=200
 *              is ACCEPTED (201) but the SERVER assigns its own uuid — the client id is
 *              IGNORED (persisted id is a 36-char uuid, never the client value).
 *   • model  → over-length (101) → 400 "messages.0.model must be shorter…100 characters";
 *              non-string → +"must be a string". model=100 ACCEPTED and round-trips VERBATIM.
 *   • parts  → non-array (string/number/object) → 400 "messages.0.parts must be an array".
 *              A populated array round-trips structurally intact.
 *   • usage  → non-object (string/number/boolean) → 400 "messages.0.usage must be an object";
 *              an ARRAY is ALSO rejected (@IsObject). A valid object round-trips intact.
 *   • Explicit `null` on every optional (id/model/parts/usage) is ACCEPTED (@IsOptional
 *     allows null) → 201, columns persist null.
 *   • @ArrayMaxSize(500): 501 elements → 400 "messages must contain no more than 500
 *     elements"; EXACTLY 500 → 201 and all 500 persist.
 *   • forbidNonWhitelisted is DEEP: an unknown key on element i → 400
 *     "messages.<i>.property <name> should not exist"; an unknown TOP-LEVEL key alongside
 *     `messages` → 400 "property <name> should not exist".
 *   • A non-object array element (null / number) → 400 "messages.each value in nested
 *     property messages must be either object or array".
 *   • ATOMIC batch: because the ValidationPipe runs the WHOLE body before the handler,
 *     a single bad element at index N rejects the ENTIRE batch — the valid elements
 *     before it persist NOTHING (probed: valid[0], valid[1], bad[2] → 400 on the
 *     `messages.2` path, ZERO rows written). The error path carries the exact index.
 *   • Multiple invalid fields in ONE element aggregate into multiple messages.
 *   • Body validation PRECEDES the ParseUUIDPipe on this route: a malformed :id + a
 *     malformed body surfaces the BODY error (not "uuid is expected").
 *   • CreateConversationDto rejects the entity columns absent from the DTO (`model`,
 *     `metadata`) → 400 "property <name> should not exist" (they are message-/server-
 *     owned, never client-settable at conversation create).
 *
 * Every reject case is a clean, deterministic 400 (a pure ValidationPipe gate — no
 * LLM key / git / Trigger.dev involvement), so statuses are pinned EXACTLY. Every
 * reject also asserts the ZERO-PERSIST invariant against a FRESH conversation:
 * validation runs before any insert, so nothing can leak.
 */

interface MessageRow {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    parts: unknown;
    model: string | null;
    usage: unknown;
    createdAt: string;
}

interface ConversationRow {
    id: string;
    userId: string;
    title: string | null;
    providerId: string | null;
    model: string | null;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
    messages?: MessageRow[];
}

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

/** Flatten the class-validator `message` (string | string[]) into one searchable string. */
function errText(json: Record<string, unknown>): string {
    const m = json.message;
    return Array.isArray(m) ? m.join(' | ') : String(m ?? '');
}

/** Assert a fresh conversation, append `body`, expect a 400 carrying `needle`, and ZERO persist. */
async function expectRejectAndZeroPersist(
    request: APIRequestContext,
    token: string,
    body: unknown,
    needle: string,
    label: string,
): Promise<void> {
    const conv = await createConversation(request, token);
    const { status, json } = await appendRaw(request, token, conv.id, body);
    expect(status, `${label} → 400 (ValidationPipe reject)`).toBe(400);
    expect(errText(json), `${label} → message names "${needle}"`).toContain(needle);

    const after = await getConversation(request, token, conv.id);
    expect(after.status, `${label}: conversation still readable`).toBe(200);
    expect(after.row?.messages, `${label}: nothing persisted`).toHaveLength(0);
    expect(after.row?.title, `${label}: no title set by a rejected append`).toBeNull();
}

// ─────────────────────────────────────────────────────────────────────────────
// AppendMessageDto.id — @IsString @MaxLength(200), server-assigned (client id ignored)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › message.id validation', () => {
    test('a 201-char id is rejected (@MaxLength 200) and persists nothing', async ({ request }) => {
        const { access_token } = await registerUserViaAPI(request);
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages: [{ role: 'user', content: 'x', id: 'i'.repeat(201) }] },
            'messages.0.id must be shorter than or equal to 200 characters',
            'id over-length',
        );
    });

    test('a non-string id (number, boolean) is rejected (@IsString) and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        for (const bad of [123, true]) {
            await expectRejectAndZeroPersist(
                request,
                access_token,
                { messages: [{ role: 'user', content: 'x', id: bad }] },
                'messages.0.id must be a string',
                `id = ${JSON.stringify(bad)}`,
            );
        }
    });

    test('a max-length (200) id is accepted, but the SERVER assigns its own uuid (client id ignored)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const clientId = 'c'.repeat(200);

        const { status } = await appendRaw(request, access_token, conv.id, {
            messages: [{ role: 'user', content: 'hello', id: clientId }],
        });
        expect(status, 'id=200 (boundary) accepted → 201').toBe(201);

        const after = await getConversation(request, access_token, conv.id);
        const msg = after.row?.messages?.[0];
        expect(msg, 'the message persisted').toBeTruthy();
        expect(msg?.id.length, 'persisted id is a server-assigned uuid (36 chars)').toBe(36);
        expect(msg?.id, 'persisted id is NOT the 200-char client id').not.toBe(clientId);
        expect(msg?.content, 'content round-tripped').toBe('hello');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AppendMessageDto.model — @IsString @MaxLength(100), round-trips verbatim
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › message.model validation', () => {
    test('a 101-char model is rejected (@MaxLength 100) and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages: [{ role: 'assistant', content: 'x', model: 'm'.repeat(101) }] },
            'messages.0.model must be shorter than or equal to 100 characters',
            'model over-length',
        );
    });

    test('a non-string model is rejected (@IsString) and persists nothing', async ({ request }) => {
        const { access_token } = await registerUserViaAPI(request);
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages: [{ role: 'assistant', content: 'x', model: 5 }] },
            'messages.0.model must be a string',
            'model = 5',
        );
    });

    test('a max-length (100) model is accepted and round-trips verbatim on the message row', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const model = 'z'.repeat(100);

        const { status } = await appendRaw(request, access_token, conv.id, {
            messages: [{ role: 'assistant', content: 'resp', model }],
        });
        expect(status, 'model=100 (boundary) accepted → 201').toBe(201);

        const after = await getConversation(request, access_token, conv.id);
        const msg = after.row?.messages?.[0];
        expect(msg?.model, 'per-message model column persisted verbatim').toBe(model);
        expect(msg?.role, 'role persisted').toBe('assistant');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AppendMessageDto.parts — @IsArray
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › message.parts validation', () => {
    test('a non-array parts (string / number / object) is rejected (@IsArray) and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const bads: Array<{ label: string; value: unknown }> = [
            { label: 'string', value: 'notarray' },
            { label: 'number', value: 5 },
            { label: 'object', value: { a: 1 } },
        ];
        for (const { label, value } of bads) {
            await expectRejectAndZeroPersist(
                request,
                access_token,
                { messages: [{ role: 'user', content: 'x', parts: value }] },
                'messages.0.parts must be an array',
                `parts = ${label}`,
            );
        }
    });

    test('an empty parts array is accepted (201)', async ({ request }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const { status } = await appendRaw(request, access_token, conv.id, {
            messages: [{ role: 'user', content: 'x', parts: [] }],
        });
        expect(status, 'empty parts array → 201').toBe(201);
        const after = await getConversation(request, access_token, conv.id);
        expect(after.row?.messages, 'message persisted').toHaveLength(1);
    });

    test('a populated parts array round-trips structurally intact through GET', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const parts = [
            { type: 'text', text: 'hi' },
            { type: 'tool-call', name: 'search' },
        ];
        const { status } = await appendRaw(request, access_token, conv.id, {
            messages: [{ role: 'assistant', content: 'resp', parts }],
        });
        expect(status, 'populated parts → 201').toBe(201);

        const after = await getConversation(request, access_token, conv.id);
        expect(
            after.row?.messages?.[0]?.parts,
            'parts JSON column round-tripped without mutation',
        ).toEqual(parts);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AppendMessageDto.usage — @IsObject (arrays rejected)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › message.usage validation', () => {
    test('a non-object usage (string / number / boolean) is rejected (@IsObject) and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        for (const bad of ['notobj', 42, true]) {
            await expectRejectAndZeroPersist(
                request,
                access_token,
                { messages: [{ role: 'user', content: 'x', usage: bad }] },
                'messages.0.usage must be an object',
                `usage = ${JSON.stringify(bad)}`,
            );
        }
    });

    test('an ARRAY usage is rejected by @IsObject (array is not a plain object)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages: [{ role: 'user', content: 'x', usage: [1, 2, 3] }] },
            'messages.0.usage must be an object',
            'usage = array',
        );
    });

    test('a valid usage object round-trips through GET', async ({ request }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const usage = { promptTokens: 5, completionTokens: 7, totalTokens: 12 };
        const { status } = await appendRaw(request, access_token, conv.id, {
            messages: [{ role: 'assistant', content: 'resp', usage }],
        });
        expect(status, 'valid usage object → 201').toBe(201);

        const after = await getConversation(request, access_token, conv.id);
        expect(after.row?.messages?.[0]?.usage, 'usage JSON column round-tripped').toEqual(usage);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// @IsOptional allows explicit null
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › optional fields accept explicit null', () => {
    test('explicit null on id/model/parts/usage is accepted (@IsOptional allows null) and persists nulls', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const { status } = await appendRaw(request, access_token, conv.id, {
            messages: [
                {
                    role: 'assistant',
                    content: 'n',
                    id: null,
                    model: null,
                    parts: null,
                    usage: null,
                },
            ],
        });
        expect(status, 'all-null optionals → 201').toBe(201);

        const after = await getConversation(request, access_token, conv.id);
        const msg = after.row?.messages?.[0];
        expect(msg?.content, 'content persisted').toBe('n');
        expect(msg?.model, 'model column null').toBeNull();
        expect(msg?.parts, 'parts column null').toBeNull();
        expect(msg?.usage, 'usage column null').toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AppendMessagesDto container — @ArrayMaxSize(500) + deep/top whitelist + element shape
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › batch container caps & whitelist', () => {
    test('501 messages exceed @ArrayMaxSize(500) → 400 and persist nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const messages = Array.from({ length: 501 }, (_, i) => ({
            role: 'user',
            content: `m${i}`,
        }));
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages },
            'messages must contain no more than 500 elements',
            '501-element batch',
        );
    });

    test('exactly 500 messages is the accepted boundary — all 500 persist', async ({ request }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);
        const messages = Array.from({ length: 500 }, (_, i) => ({
            role: 'user',
            content: `m${i}`,
        }));
        const { status } = await appendRaw(request, access_token, conv.id, { messages });
        expect(status, '500-element batch (boundary) → 201').toBe(201);

        const after = await getConversation(request, access_token, conv.id);
        expect(after.row?.messages, 'all 500 rows persisted').toHaveLength(500);
    });

    test('an unknown TOP-LEVEL key alongside messages is rejected (forbidNonWhitelisted) and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages: [{ role: 'user', content: 'x' }], topextra: 1 },
            'property topextra should not exist',
            'top-level extra key',
        );
    });

    test('an unknown key on a message ELEMENT is rejected with the indexed path and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        await expectRejectAndZeroPersist(
            request,
            access_token,
            { messages: [{ role: 'user', content: 'x', bogus: 1 }] },
            'messages.0.property bogus should not exist',
            'nested extra key',
        );
    });

    test('a non-object array element (null / number) is rejected and persists nothing', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        for (const bad of [null, 123]) {
            await expectRejectAndZeroPersist(
                request,
                access_token,
                { messages: [bad] },
                'must be either object or array',
                `element = ${JSON.stringify(bad)}`,
            );
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-batch atomicity + index-path accuracy + multi-error aggregation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › batch is validated atomically before any insert', () => {
    test('a bad element at index 2 rejects the WHOLE batch — the valid leading elements persist NOTHING', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);

        // Two valid elements followed by an enum-invalid role at index 2. Because
        // the ValidationPipe validates the entire body before the handler runs,
        // the whole batch is rejected — the valid elements 0 and 1 are NEVER
        // inserted (atomic), and the error path pins the offending index.
        const { status, json } = await appendRaw(request, access_token, conv.id, {
            messages: [
                { role: 'user', content: 'v0' },
                { role: 'assistant', content: 'v1' },
                { role: 'bogusrole', content: 'v2' },
            ],
        });
        expect(status, 'bad-at-index-2 batch → 400').toBe(400);
        expect(errText(json), 'error path carries the exact index (messages.2.role)').toContain(
            'messages.2.role must be one of the following values',
        );

        const after = await getConversation(request, access_token, conv.id);
        expect(
            after.row?.messages,
            'not even the valid leading elements persisted (atomic reject)',
        ).toHaveLength(0);
        expect(after.row?.title, 'no title from an atomically-rejected batch').toBeNull();
    });

    test('multiple invalid fields in ONE element aggregate into multiple error messages', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const conv = await createConversation(request, access_token);

        const { status, json } = await appendRaw(request, access_token, conv.id, {
            messages: [{ role: 'nope', content: 'x', model: 'm'.repeat(101) }],
        });
        expect(status, 'multi-invalid element → 400').toBe(400);
        const msg = errText(json);
        expect(msg, 'reports the role-enum violation').toContain('messages.0.role must be one of');
        expect(msg, 'AND the model length violation').toContain(
            'messages.0.model must be shorter than or equal to 100 characters',
        );

        const after = await getConversation(request, access_token, conv.id);
        expect(after.row?.messages, 'nothing persisted').toHaveLength(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route pipeline ordering + create-side entity-column whitelist
// ─────────────────────────────────────────────────────────────────────────────
test.describe('append › pipeline ordering and create whitelist', () => {
    test('on the append route, BODY validation precedes the uuid pipe (malformed id + malformed body → body error)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // Both the :id (not a uuid) and the body (bare-string element) are invalid.
        // The global ValidationPipe on the body runs before the ParseUUIDPipe on the
        // param, so the surfaced 400 is the BODY error — never "uuid is expected".
        const { status, json } = await appendRaw(request, access_token, 'not-a-uuid', {
            messages: ['bare string bad'],
        });
        expect(status, 'malformed id + malformed body → 400').toBe(400);
        const msg = errText(json);
        expect(msg, 'the body error wins').toContain('must be either object or array');
        expect(msg, 'the uuid-pipe error is NOT what surfaced').not.toContain('uuid is expected');
    });

    test('conversation create rejects entity columns absent from the DTO (model, metadata)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // `model` and `metadata` are real (nullable) columns on the Conversation
        // entity but are NOT part of CreateConversationDto — they are message-/
        // server-owned and must not be client-settable at create time.
        for (const field of ['model', 'metadata'] as const) {
            const res = await request.post(`${API_BASE}/api/conversations`, {
                headers: authedHeaders(access_token),
                data: { title: 'x', [field]: field === 'metadata' ? { a: 1 } : 'gpt-4' },
            });
            expect(res.status(), `create with ${field} → 400 (forbidNonWhitelisted)`).toBe(400);
            const json = (await res.json()) as Record<string, unknown>;
            expect(errText(json), `names the forbidden ${field} property`).toContain(
                `property ${field} should not exist`,
            );
        }
    });
});

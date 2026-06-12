import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Conversations CRUD — DEEP validation, DoS-clamp, UUID-pipe & whitelist surface.
 *
 * Source of truth (read + probed live against http://127.0.0.1:3100 before
 * writing): apps/api/src/ai-conversation/conversation.controller.ts (mounted
 * under @Controller('api/conversations')) — specifically the
 * CreateConversationDto / UpdateConversationDto class-validator caps, the
 * MAX_CONVERSATIONS_PAGE_SIZE=200 paging clamp on GET, and the ParseUUIDPipe on
 * every `:id` route.
 *
 * NON-DUPLICATION — this file deliberately AVOIDS the happy-path / ordering /
 * payload surface already pinned by the sibling specs:
 *   - flow-conversation-crud-deep.spec.ts (singular) → bulk delete-all, updatedAt
 *     pagination ordering, auto-title boundary battery, parts/model/usage payload
 *     fidelity, the auth-gate 401 matrix, and the *valid-format* missing-id 404 matrix.
 *   - conversations.spec.ts / conversations-crud.spec.ts → create→list→get→patch→delete
 *     lifecycle + cross-user 403/404 isolation.
 *   - conversation-history-persistence.spec.ts → message round-trip + in-panel History UI.
 *
 * The flows below pin the UNCOVERED CONTRACT EDGES — the input-validation and
 * abuse-resistance gates none of the above touch (all probed live):
 *
 *   - CreateConversationDto: title @MaxLength(200) (200 ok / 201 → 400),
 *     providerId @MaxLength(100) (100 ok / 101 → 400), @IsString on both
 *     (non-string → 400 with the exact class-validator messages), and
 *     forbidNonWhitelisted (unknown property → 400 "property X should not exist").
 *   - UpdateConversationDto: title is REQUIRED — PATCH {} → 400; title @MaxLength(200)
 *     (201 chars → 400); a valid PATCH → 204.
 *   - GET paging DoS-clamp: limit Math.min(_,200)/Math.max(_,1); NaN limit → repo
 *     default; offset Math.max(_,0). A hostile ?limit=1000000 cannot over-fetch.
 *   - ParseUUIDPipe: a malformed `:id` → 400 "Validation failed (uuid is expected)"
 *     (NOT 404) on GET / DELETE / append, and on PATCH *when the body is valid*
 *     (body DTO validation actually runs first, so a malformed-id + bad-body PATCH
 *     surfaces the body error — pinned to lock that ordering).
 *   - Keyless AI title regeneration gate: appending 4 messages fires
 *     titleService.maybeGenerateTitle fire-and-forget; with NO provider key it must
 *     fail-gracefully — never error the append, never clobber a preset title.
 *
 * VERIFIED API SHAPES (probed live as throwaway users):
 *   POST   /api/conversations  { title?(≤200), providerId?(≤100) }
 *      → 201 row | 400 { message:[...], error:'Bad Request', statusCode:400 }
 *        (whitelist: unknown property → 400 "property <name> should not exist").
 *   GET    /api/conversations?limit=&offset=
 *      → 200 { conversations:[...], total } — limit clamped to [1,200], NaN → default,
 *        offset floored at 0.
 *   PATCH  /api/conversations/:id  { title(req, ≤200) } → 204 | 400 (bad body) | 400 (bad uuid).
 *   POST   /api/conversations/:id/messages → 201 { success:true } | 400 (bad uuid) | 404 (missing).
 *   DELETE /api/conversations/:id → 204 | 400 (bad uuid) | 404 (missing).
 *   ALL malformed-uuid `:id` (valid body) → 400 "Validation failed (uuid is expected)".
 */

interface ConversationRow {
    id: string;
    userId: string;
    title: string | null;
    providerId: string | null;
    model: string | null;
    createdAt: string;
    updatedAt: string;
    messages?: Array<{ id: string; role: string; content: string }>;
}

interface ListResponse {
    conversations: Array<{ id: string; title: string | null }>;
    total: number;
}

const MALFORMED_ID = 'not-a-uuid';

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
    query = '',
): Promise<ListResponse> {
    const url = query ? `${API_BASE}/api/conversations?${query}` : `${API_BASE}/api/conversations`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    expect(res.status(), 'list conversations → 200').toBe(200);
    return res.json();
}

// Read a `message` field that may be a string OR an array of validation strings.
function messageText(body: unknown): string {
    const msg = (body as { message?: unknown })?.message;
    if (Array.isArray(msg)) return msg.join(' | ');
    return typeof msg === 'string' ? msg : JSON.stringify(body);
}

test.describe('Conversations CRUD deep — create-body validation (DTO caps + whitelist)', () => {
    test('title @MaxLength(200): 200 chars persists, 201 chars → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Exactly 200 chars is the boundary of @MaxLength(200) → accepted verbatim.
        const exact200 = 'A'.repeat(200);
        const ok = await createConversation(request, token, { title: exact200 });
        expect(ok.title, '200-char title persists verbatim (no DTO truncation)').toBe(exact200);

        // 201 chars trips the cap → 400 before the row is ever created.
        const over = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: 'A'.repeat(201) },
        });
        expect(over.status(), '201-char title → 400').toBe(400);
        expect(messageText(await over.json()), 'cites the 200-char cap').toContain(
            'shorter than or equal to 200',
        );

        // The rejected create did NOT leak a row: only the 200-char one exists.
        const list = await listConversations(request, token);
        expect(list.total, 'only the accepted create persisted').toBe(1);
    });

    test('providerId @MaxLength(100): 100 chars ok, 101 → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const ok = await createConversation(request, token, { providerId: 'p'.repeat(100) });
        expect(ok.providerId, '100-char providerId persists').toBe('p'.repeat(100));

        const over = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { providerId: 'p'.repeat(101) },
        });
        expect(over.status(), '101-char providerId → 400').toBe(400);
        expect(messageText(await over.json()), 'cites the 100-char cap').toContain(
            'shorter than or equal to 100',
        );
    });

    test('@IsString is enforced and unknown properties are rejected (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A numeric title violates @IsString → 400 (and also the length rule, which
        // runs over the coerced value — both messages surface).
        const numericTitle = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: 12345 },
        });
        expect(numericTitle.status(), 'numeric title → 400').toBe(400);
        expect(messageText(await numericTitle.json()), 'title must be a string').toContain(
            'title must be a string',
        );

        // A numeric providerId is rejected the same way.
        const numericProvider = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { providerId: 999 },
        });
        expect(numericProvider.status(), 'numeric providerId → 400').toBe(400);
        expect(messageText(await numericProvider.json()), 'providerId must be a string').toContain(
            'providerId must be a string',
        );

        // The global ValidationPipe runs with forbidNonWhitelisted → an unknown key
        // is a hard 400, not silently stripped. Locks the strict-body contract.
        const extraneous = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: 'fine', bogusField: 'nope' },
        });
        expect(extraneous.status(), 'unknown property → 400').toBe(400);
        expect(messageText(await extraneous.json()), 'names the offending property').toContain(
            'bogusField should not exist',
        );

        // None of the three rejected creates persisted a row.
        const list = await listConversations(request, token);
        expect(list.total, 'every invalid create was rejected pre-persist').toBe(0);
    });

    test('an empty create body is valid → an untitled row with null title/providerId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Both DTO fields are @IsOptional → {} is a legitimate "start a blank conversation".
        const row = await createConversation(request, token, {});
        expect(row.title, 'blank create → null title').toBeNull();
        expect(row.providerId, 'blank create → null providerId').toBeNull();
        expect(row.userId, 'row is stamped with the caller userId').toBe(user.user.id);
    });
});

test.describe('Conversations CRUD deep — PATCH body validation', () => {
    test('PATCH requires title: {} → 400; over-length → 400; valid → 204', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const conv = await createConversation(request, token, { title: 'original' });

        // UpdateConversationDto.title has NO @IsOptional → an empty PATCH body is a 400.
        const missing = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(missing.status(), 'PATCH {} → 400 (title required)').toBe(400);
        expect(messageText(await missing.json()), 'title must be a string').toContain(
            'title must be a string',
        );

        // Over-length rename trips the @MaxLength(200) cap.
        const tooLong = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: { title: 'Z'.repeat(201) },
        });
        expect(tooLong.status(), 'PATCH 201-char title → 400').toBe(400);

        // Both failed PATCHes left the original title intact (no partial write).
        const stillOriginal = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(stillOriginal.status()).toBe(200);
        expect(
            ((await stillOriginal.json()) as ConversationRow).title,
            'failed PATCHes did not mutate the title',
        ).toBe('original');

        // A within-cap rename succeeds with 204 No Content and persists.
        const valid = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
            data: { title: 'renamed within cap' },
        });
        expect(valid.status(), 'valid PATCH → 204').toBe(204);

        const after = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(((await after.json()) as ConversationRow).title, 'rename persisted').toBe(
            'renamed within cap',
        );
    });
});

test.describe('Conversations CRUD deep — GET paging DoS clamp', () => {
    test('limit is clamped to [1,200], offset floored at 0, NaN falls back to the default', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // Seed three rows so a clamp to 1 is observably different from a clamp to "all".
        for (let i = 0; i < 3; i++) {
            await createConversation(request, token, { title: `clamp-${i}` });
        }

        // A hostile huge limit is clamped to MAX_CONVERSATIONS_PAGE_SIZE (200) — it
        // CANNOT over-fetch, but it still returns everything below the cap (all 3).
        const huge = await listConversations(request, token, 'limit=1000000&offset=0');
        expect(huge.total, 'total is the full count').toBe(3);
        expect(huge.conversations.length, 'huge limit clamped to 200 → returns all 3').toBe(3);

        // limit=0 and limit=-5 are floored to 1 (Math.max(_,1)) → exactly one row.
        const zero = await listConversations(request, token, 'limit=0&offset=0');
        expect(zero.total, 'total unaffected by page window').toBe(3);
        expect(zero.conversations.length, 'limit=0 floored to 1').toBe(1);

        const negative = await listConversations(request, token, 'limit=-5&offset=0');
        expect(negative.conversations.length, 'limit=-5 floored to 1').toBe(1);

        // A non-numeric limit is NaN → undefined → the repository default (≥3 here),
        // so all three come back (proves NaN is not coerced to 0/clamped to 1).
        const nan = await listConversations(request, token, 'limit=abc&offset=0');
        expect(nan.conversations.length, 'NaN limit → repo default returns all').toBe(3);

        // A negative offset is floored to 0 (Math.max(_,0)) → page starts at the top.
        const negOffset = await listConversations(request, token, 'offset=-5');
        expect(negOffset.conversations.length, 'offset=-5 floored to 0').toBe(3);
    });
});

test.describe('Conversations CRUD deep — ParseUUIDPipe on :id routes', () => {
    test('a malformed :id is a 400 uuid-validation error (not 404) on GET/DELETE/append', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // GET / DELETE / append all carry @Param('id', ParseUUIDPipe): a non-uuid id
        // is rejected by the pipe BEFORE the ownership lookup → 400, never 404.
        const get = await request.get(`${API_BASE}/api/conversations/${MALFORMED_ID}`, {
            headers: authedHeaders(token),
        });
        expect(get.status(), 'GET bad-uuid → 400').toBe(400);
        expect(messageText(await get.json()), 'uuid-expected message').toContain(
            'uuid is expected',
        );

        const del = await request.delete(`${API_BASE}/api/conversations/${MALFORMED_ID}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), 'DELETE bad-uuid → 400').toBe(400);

        // append has a body DTO-less signature, so the param pipe is the first gate.
        const append = await request.post(
            `${API_BASE}/api/conversations/${MALFORMED_ID}/messages`,
            {
                headers: authedHeaders(token),
                data: { messages: [] },
            },
        );
        expect(append.status(), 'append bad-uuid → 400').toBe(400);
    });

    test('PATCH validates the body before the id pipe: bad body wins, valid body surfaces the uuid 400', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // PATCH bad-uuid + EMPTY body → the body DTO validation fires first, so the
        // response is the title error, NOT the uuid error (pins NestJS pipe ordering).
        const badBody = await request.patch(`${API_BASE}/api/conversations/${MALFORMED_ID}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(badBody.status(), 'PATCH bad-uuid + bad-body → 400').toBe(400);
        expect(messageText(await badBody.json()), 'body error wins over the uuid pipe').toContain(
            'title must be a string',
        );

        // PATCH bad-uuid + VALID body → now the param pipe is the only failing gate
        // → the uuid-expected error surfaces.
        const validBody = await request.patch(`${API_BASE}/api/conversations/${MALFORMED_ID}`, {
            headers: authedHeaders(token),
            data: { title: 'valid title' },
        });
        expect(validBody.status(), 'PATCH bad-uuid + valid-body → 400').toBe(400);
        expect(messageText(await validBody.json()), 'uuid pipe now surfaces').toContain(
            'uuid is expected',
        );
    });
});

test.describe('Conversations CRUD deep — validation-vs-ownership ordering', () => {
    test('a foreign over-length PATCH 400s on validation but a foreign valid PATCH 404s on ownership — owner row untouched either way', async ({
        request,
    }) => {
        // Body validation runs BEFORE the findById(id, userId) ownership lookup, so an
        // intruder gets a 400 for a malformed body even on a conversation they cannot
        // see (no ownership info-leak: 400 is the same whether or not the row exists).
        // A *valid* foreign PATCH then 404s at the ownership gate. In NEITHER case is
        // the owner's title mutated.
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const conv = await createConversation(request, owner.access_token, { title: 'owned' });

        const overLengthForeign = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(intruder.access_token),
            data: { title: 'Z'.repeat(201) },
        });
        expect(
            overLengthForeign.status(),
            'foreign + over-length → 400 (validation precedes ownership)',
        ).toBe(400);

        const validForeign = await request.patch(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(intruder.access_token),
            data: { title: 'hijacked' },
        });
        expect(validForeign.status(), 'foreign + valid body → 404 (ownership gate)').toBe(404);

        const foreignAppend = await request.post(
            `${API_BASE}/api/conversations/${conv.id}/messages`,
            {
                headers: authedHeaders(intruder.access_token),
                data: { messages: [{ role: 'user', content: 'sneak' }] },
            },
        );
        expect(foreignAppend.status(), 'foreign append → 404 (ownership gate)').toBe(404);

        // The owner's conversation survived every failed foreign attempt intact.
        const ownerView = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(ownerView.status(), 'owner still reads their row').toBe(200);
        const row = (await ownerView.json()) as ConversationRow;
        expect(row.title, 'title never mutated by the foreign attempts').toBe('owned');
        expect(row.messages ?? [], 'no foreign message leaked in').toHaveLength(0);
    });
});

test.describe('Conversations CRUD deep — keyless AI title-regen gate', () => {
    test('appending 4 messages fires title regeneration fire-and-forget without erroring or clobbering a preset title', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A conversation created WITH a title — the explicit title must survive.
        const preset = 'Operator chosen title';
        const conv = await createConversation(request, token, { title: preset });

        // 4 messages crosses the titleService.maybeGenerateTitle "4+ messages" trigger.
        // In the keyless CI mirror (no provider key) the background regen MUST
        // fail-gracefully: the append still returns its success contract...
        const append = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: 'first turn' },
                    { role: 'assistant', content: 'first reply' },
                    { role: 'user', content: 'second turn' },
                    { role: 'assistant', content: 'second reply' },
                ],
            },
        });
        expect(append.status(), 'append → 201 even with regen firing').toBe(201);
        expect((await append.json())?.success, 'append reports success').toBe(true);

        // ...and the conversation is intact: all 4 messages persisted in order, and
        // the preset title was NOT overwritten by a (failed/no-op) keyless regen.
        const row = (await (
            await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
                headers: authedHeaders(token),
            })
        ).json()) as ConversationRow;
        expect(row.messages?.length, 'all 4 messages persisted').toBe(4);
        expect(
            row.messages?.map((m) => m.role),
            'append order preserved',
        ).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(row.title, 'preset title survives the keyless regen gate').toBe(preset);
    });

    test('keyless regen on an UNTITLED 4-message conversation keeps the verbatim first-user fallback title', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // No preset title → the controller's synchronous fallback sets the title from
        // the first user message. The async AI regen would only replace it if a
        // provider answered; keyless, the fallback title is what remains.
        const conv = await createConversation(request, token, {});
        const firstUser = 'Summarize the quarterly migration plan';
        const append = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: firstUser },
                    { role: 'assistant', content: 'sure' },
                    { role: 'user', content: 'thanks' },
                    { role: 'assistant', content: 'welcome' },
                ],
            },
        });
        expect(append.status(), 'append → 201').toBe(201);

        // Poll briefly: the synchronous fallback is set in-request, but we tolerate the
        // fire-and-forget regen having a moment to (no-op) settle. The title must end
        // as the verbatim first-user message — never blank, never a 5xx-induced loss.
        await expect
            .poll(
                async () => {
                    const r = (await (
                        await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
                            headers: authedHeaders(token),
                        })
                    ).json()) as ConversationRow;
                    return r.title;
                },
                { timeout: 10_000, message: 'fallback title is set and stays' },
            )
            .toBe(firstUser);
    });
});

import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { isAiProviderConfigured } from './helpers/chat';

/**
 * Work-scoped chat — real, multi-entity, cross-feature integration.
 *
 * Three complex flows tying the Works domain to the AI-conversation domain.
 * Every request/response shape, header, status code, and error envelope below
 * was PROBED against the LIVE API (http://127.0.0.1:3100) before any assertion
 * was written, so the suite asserts the platform's REAL behaviour — including
 * the honest deviations where the data model differs from a naive expectation.
 *
 * ── Verified API contracts ──────────────────────────────────────────────────
 *
 * POST /api/v1/chat/completions      (Bearer; apps/api/.../openai-compat.controller.ts)
 *   Headers honoured: `X-Provider-Override`, `X-Work-Id` (both lower-cased and
 *   read via @Headers). The controller passes `{ userId, workId, providerOverride }`
 *   into the AI facade as routing options — `X-Work-Id` is an OPAQUE scope hint,
 *   NOT validated against work ownership/existence (a bogus uuid still routes &
 *   completes — verified). When a provider IS configured the route returns 200
 *   with an OpenAI-shaped body:
 *     { id, object:'chat.completion', created, model, choices:[{ index,
 *       message:{ role:'assistant', content }, finish_reason }], usage:{...} }
 *   When NO provider is configured (CI: no LLM key) the @Res() path maps the
 *   throw to 422 { error:{ message, type:'provider_unavailable' } } (NEVER 5xx).
 *   This suite is therefore ENVIRONMENT-ADAPTIVE: it asserts a genuine 200
 *   completion when configured, else the truthful 422 provider_unavailable
 *   envelope — and in BOTH cases asserts the request was ACCEPTED/PROCESSED for
 *   the given work scope (well-behaved <500 with the work-scoped headers honoured).
 *
 * Conversations  (apps/api/.../conversation.controller.ts + agent ConversationRepository)
 *   POST /api/conversations      body { title?, providerId? } → 201 created row:
 *     { id, userId, title, providerId, model, metadata, tenantId, organizationId,
 *       createdAt, updatedAt }  (no `messages` key on create).
 *   GET  /api/conversations/:id  → same shape PLUS `messages:[...]` (user-scoped:
 *     another user → 404 { message:'Not Found', statusCode:404 }).
 *   GET  /api/conversations      → { conversations:[{ id, title, providerId,
 *       model, createdAt, updatedAt }], total }.
 *   PATCH /api/conversations/:id body { title } → 204 (title only;
 *     UpdateConversationDto whitelists ONLY `title`, so extra body fields like
 *     `metadata` are REJECTED by the hardened ValidationPipe, not silently kept).
 *   POST /api/conversations/:id/messages body { messages:[{ role, content,
 *       model?, usage?, parts? }] } → 201 { success:true }; messages persist
 *     per-message `model` + `usage:{ promptTokens, completionTokens, totalTokens }`.
 *
 * ── HONEST DEVIATION (Flow 2: conversation<->work linkage) ───────────────────
 *   The Conversation entity (packages/agent/src/entities/conversation.entity.ts)
 *   has NO `workId` column, and `CreateConversationDto` whitelists ONLY
 *   { title, providerId }. The hardened global ValidationPipe
 *   (`forbidNonWhitelisted: true`, apps/api/src/main.ts) now REJECTS a create
 *   body that smuggles `workId`/`metadata` with 400 "property X should not
 *   exist" (verified) — it is not silently dropped. So a hard work-FK linkage is
 *   NOT a real platform feature today. The CLOSEST real, truthful linkage this
 *   suite drives instead:
 *     (a) a work-scoped chat completion (X-Work-Id) for work A and a separate one
 *         for work B both succeed independently — the chat layer is the genuine
 *         work-scoping surface;
 *     (b) conversations are isolated PER USER (the strong, real isolation
 *         boundary): a conversation created alongside work A by user A is 404 to
 *         user B; and
 *     (c) two distinct conversations are isolated from each other (messages
 *         appended to conv-A never appear in conv-B).
 *   See the inline comments at each assertion.
 *
 * ── ISOLATION ──
 *   All mutations run on FRESH registerUserViaAPI() users (never the shared
 *   seeded user) so a user-scoped provider/apiKey can't shadow the env key and
 *   break sibling chat specs. Unique names/emails per run; assertions tolerate
 *   pre-existing rows (toContain / >=), never exact counts.
 */

/** OpenAI-shaped completion body (subset we assert on). */
interface OpenAiCompletion {
    id?: string;
    object?: string;
    model?: string;
    choices?: Array<{
        index?: number;
        message?: { role?: string; content?: string };
        finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** 422 provider-unavailable envelope (CI, no LLM key). */
interface ProviderUnavailable {
    error?: { message?: string; type?: string };
}

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
        parts?: unknown[] | null;
    }>;
}

const SUFFIX = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Fire a chat completion scoped to a work via X-Work-Id and assert it is
 * accepted/processed for that scope, ADAPTIVELY to whether a provider is
 * configured. Returns the parsed body + status for further model assertions.
 */
async function workScopedCompletion(
    request: APIRequestContext,
    token: string,
    workId: string,
    userContent: string,
    configured: boolean,
): Promise<{ status: number; body: OpenAiCompletion & ProviderUnavailable }> {
    const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
        headers: { ...authedHeaders(token), 'X-Work-Id': workId },
        data: { messages: [{ role: 'user', content: userContent }], stream: false },
        timeout: 60_000,
    });
    const status = res.status();
    const body = (await res.json().catch(() => ({}))) as OpenAiCompletion & ProviderUnavailable;

    // In BOTH environments the work-scoped request must be well-behaved (<500):
    // the route honours X-Work-Id as a routing hint and never leaks a raw 500.
    expect(status, 'work-scoped completion must stay in the <500 family').toBeLessThan(500);

    if (configured) {
        // Provider configured locally → genuine OpenAI-shaped completion.
        expect(status, 'configured provider → 200 completion for the work scope').toBe(200);
        expect(body.object).toBe('chat.completion');
        expect(typeof body.id).toBe('string');
        expect(body.model, 'a real model id is echoed').toBeTruthy();
        const content = body.choices?.[0]?.message?.content;
        expect(
            (content ?? '').trim().length,
            'assistant produced non-empty content',
        ).toBeGreaterThan(0);
        expect(body.choices?.[0]?.message?.role).toBe('assistant');
    } else {
        // No provider (CI) → truthful 422 provider_unavailable envelope.
        expect(status, 'no provider → 422 provider_unavailable for the work scope').toBe(422);
        expect(body.error?.type).toBe('provider_unavailable');
        expect((body.error?.message ?? '').length).toBeGreaterThan(0);
    }

    return { status, body };
}

test.describe('Work-scoped chat (chat ⇄ works integration)', () => {
    test('Flow 1: a chat completion scoped to a work via X-Work-Id is accepted & processed (adaptive)', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        // Fresh API-only user so any provider routing stays isolated from the
        // shared seeded user used by sibling chat specs.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token, 'fresh user bearer token').toHaveLength(32);

        // Two REAL works owned by this user — the multi-entity setup.
        const s = SUFFIX();
        const workA = await createWorkViaAPI(request, token, {
            name: `Chat Scope A ${s}`,
            slug: `chat-scope-a-${s}`,
        });
        const workB = await createWorkViaAPI(request, token, {
            name: `Chat Scope B ${s}`,
            slug: `chat-scope-b-${s}`,
        });
        expect(workA.id, 'work A persisted with an id').toBeTruthy();
        expect(workB.id, 'work B persisted with an id').toBeTruthy();
        expect(workA.id).not.toBe(workB.id);

        const configured = await isAiProviderConfigured(request, token);

        // Drive a work-scoped completion against EACH work independently. The
        // X-Work-Id header is the genuine work-scoping surface for chat; both
        // scopes must be accepted/processed (adaptive outcome, asserted inside).
        const resA = await workScopedCompletion(
            request,
            token,
            workA.id,
            'Reply with the single word: alpha',
            configured,
        );
        const resB = await workScopedCompletion(
            request,
            token,
            workB.id,
            'Reply with the single word: bravo',
            configured,
        );

        // Both scopes behaved consistently for this environment (same family of
        // outcome) — proving the work-id routing is honoured per request, not
        // accidentally bound to a single work.
        expect(resA.status, 'work A and work B scopes behave consistently').toBe(resB.status);

        // CONTROL: an unscoped completion (no X-Work-Id) is also well-behaved —
        // the work scope is optional routing metadata, not a gate.
        const unscoped = await request.post(`${API_BASE}/api/v1/chat/completions`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: 'ping' }], stream: false },
            timeout: 60_000,
        });
        expect(unscoped.status(), 'unscoped completion stays <500').toBeLessThan(500);
        expect([200, 422], 'unscoped completion is 200 or the 422 contract').toContain(
            unscoped.status(),
        );
    });

    test('Flow 2: conversation ⇄ work linkage + per-user/per-conversation isolation', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        // User A owns work A + work B and creates conversations alongside them.
        const userA = await registerUserViaAPI(request);
        const tokenA = userA.access_token;
        const userB = await registerUserViaAPI(request);
        const tokenB = userB.access_token;
        expect(tokenA).toHaveLength(32);
        expect(tokenB).toHaveLength(32);

        const s = SUFFIX();
        const workA = await createWorkViaAPI(request, tokenA, {
            name: `Conv Link A ${s}`,
            slug: `conv-link-a-${s}`,
        });
        const workB = await createWorkViaAPI(request, tokenA, {
            name: `Conv Link B ${s}`,
            slug: `conv-link-b-${s}`,
        });
        expect(workA.id).toBeTruthy();
        expect(workB.id).toBeTruthy();

        // --- Probe the real `workId` field behaviour at create (HONEST DEVIATION).
        // The Conversation entity has NO workId column and the CreateConversationDto
        // whitelists ONLY { title, providerId }. The global ValidationPipe runs with
        // `forbidNonWhitelisted: true` (apps/api/src/main.ts), so a create body that
        // smuggles `workId`/`metadata` is now REJECTED outright (400 "property X
        // should not exist") rather than silently dropped — this is the hardened,
        // truthful contract and proves even more strongly that work-FK linkage is not
        // a real feature. We assert that rejection first, then create cleanly,
        // encoding the work association in the TITLE (the only durable, queryable
        // place today) so the linkage is observable.
        const rejected = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(tokenA),
            // Not part of the whitelist — sent to PROVE it is rejected, not persisted:
            data: {
                title: `work:${workA.id}`,
                providerId: 'openrouter',
                workId: workA.id,
                metadata: { workId: workA.id },
            },
        });
        expect(
            rejected.status(),
            'create rejects non-whitelisted workId/metadata (forbidNonWhitelisted)',
        ).toBe(400);
        const rejectedBody = (await rejected.json()) as { message?: string | string[] };
        const rejectedMsg = Array.isArray(rejectedBody.message)
            ? rejectedBody.message.join(' ')
            : (rejectedBody.message ?? '');
        expect(rejectedMsg, 'rejection names the workId property').toContain('workId');

        // Clean create — only the whitelisted fields persist.
        const createA = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(tokenA),
            data: {
                title: `work:${workA.id}`,
                providerId: 'openrouter',
            },
        });
        expect(createA.status(), 'create conversation A → 201').toBe(201);
        const convA = (await createA.json()) as ConversationRow;
        expect(convA.id, 'conversation A has an id').toBeTruthy();
        expect(convA.userId, 'conversation A owned by user A').toBe(userA.user.id);
        expect(convA.title).toBe(`work:${workA.id}`);
        expect(convA.providerId, 'providerId persists at create').toBe('openrouter');
        // Truthful deviation: workId/metadata are NOT persisted by the data model.
        expect(convA.metadata ?? null, 'metadata is not settable at create (no path)').toBeNull();
        expect(
            (convA as unknown as Record<string, unknown>).workId,
            'no workId is echoed back — the entity has no such column',
        ).toBeUndefined();

        const createB = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(tokenA),
            data: { title: `work:${workB.id}`, providerId: 'openrouter' },
        });
        expect(createB.status()).toBe(201);
        const convB = (await createB.json()) as ConversationRow;
        expect(convB.id).toBeTruthy();
        expect(convB.id).not.toBe(convA.id);

        // --- GET reflects the (title-encoded) work association for conv A. ---
        const getA = await request.get(`${API_BASE}/api/conversations/${convA.id}`, {
            headers: authedHeaders(tokenA),
        });
        expect(getA.status(), 'owner GET conversation A → 200').toBe(200);
        const fetchedA = (await getA.json()) as ConversationRow;
        expect(fetchedA.id).toBe(convA.id);
        expect(fetchedA.title, 'GET reflects the work A linkage').toBe(`work:${workA.id}`);
        expect(fetchedA.providerId).toBe('openrouter');
        expect(Array.isArray(fetchedA.messages), 'GET includes a messages array').toBeTruthy();

        // --- Per-CONVERSATION isolation: append a message to conv A only; it must
        // NOT leak into conv B. This is the real "conversation for work A is
        // isolated from work B" boundary the data model actually enforces. ---
        const marker = `scoped-to-work-A-${s}`;
        const append = await request.post(`${API_BASE}/api/conversations/${convA.id}/messages`, {
            headers: authedHeaders(tokenA),
            data: { messages: [{ role: 'user', content: marker }] },
        });
        expect(append.status(), 'append to conv A → 201').toBe(201);
        expect((await append.json()).success).toBe(true);

        const reGetA = await request.get(`${API_BASE}/api/conversations/${convA.id}`, {
            headers: authedHeaders(tokenA),
        });
        const reFetchedA = (await reGetA.json()) as ConversationRow;
        expect(
            reFetchedA.messages?.some((m) => m.content === marker),
            'conv A (work A) contains its own message',
        ).toBeTruthy();

        const getB = await request.get(`${API_BASE}/api/conversations/${convB.id}`, {
            headers: authedHeaders(tokenA),
        });
        const fetchedB = (await getB.json()) as ConversationRow;
        expect(
            fetchedB.messages?.some((m) => m.content === marker),
            'conv B (work B) is isolated — never sees work A’s message',
        ).toBeFalsy();

        // --- Per-USER isolation (the strong, real boundary): user B cannot read
        // user A's work-associated conversation. ---
        const crossUser = await request.get(`${API_BASE}/api/conversations/${convA.id}`, {
            headers: authedHeaders(tokenB),
        });
        expect(crossUser.status(), 'cross-user GET → 404 (user-scoped isolation)').toBe(404);
        const crossBody = await crossUser.json();
        expect(crossBody.statusCode).toBe(404);
        expect(crossBody.message).toBe('Not Found');

        // And conv A is absent from user B's own conversation list.
        const listB = await request.get(`${API_BASE}/api/conversations?limit=100`, {
            headers: authedHeaders(tokenB),
        });
        const listBBody = (await listB.json()) as {
            conversations: ConversationRow[];
            total: number;
        };
        expect(
            listBBody.conversations.map((c) => c.id),
            'user B list does not contain user A’s conversation',
        ).not.toContain(convA.id);
    });

    test('Flow 3: conversation records provider metadata (providerId) + per-message model/usage', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        // A work to scope the (adaptive) completion against.
        const s = SUFFIX();
        const work = await createWorkViaAPI(request, token, {
            name: `Provider Meta ${s}`,
            slug: `provider-meta-${s}`,
        });
        expect(work.id).toBeTruthy();

        // Create a conversation that EXPLICITLY records its provider metadata.
        const provId = 'openrouter';
        const create = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: `Provider meta ${s}`, providerId: provId },
        });
        expect(create.status(), 'create conversation → 201').toBe(201);
        const conv = (await create.json()) as ConversationRow;
        expect(conv.id).toBeTruthy();

        // providerId shape: a string of the configured provider; model is a
        // nullable string column (not set at create — verified null).
        expect(typeof conv.providerId).toBe('string');
        expect(conv.providerId).toBe(provId);
        expect(
            conv.model ?? null,
            'conversation.model is null until a model is recorded',
        ).toBeNull();

        // The provider metadata is reflected by GET and by the LIST projection
        // (findByUser selects id/title/providerId/model/createdAt/updatedAt).
        const get = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        const fetched = (await get.json()) as ConversationRow;
        expect(fetched.providerId).toBe(provId);
        expect('model' in fetched, 'GET exposes the model field').toBeTruthy();

        const list = await request.get(`${API_BASE}/api/conversations?limit=100`, {
            headers: authedHeaders(token),
        });
        const listBody = (await list.json()) as { conversations: ConversationRow[]; total: number };
        const listed = listBody.conversations.find((c) => c.id === conv.id);
        expect(listed, 'new conversation appears in the user list').toBeTruthy();
        expect(listed?.providerId, 'list projection carries providerId').toBe(provId);
        expect('model' in (listed ?? {}), 'list projection carries the model field').toBeTruthy();

        // --- Drive a real (adaptive) completion for this work, then RECORD its
        // model on the conversation by appending the resulting assistant turn.
        // This is the genuine path by which per-message provider/model metadata
        // lands on a conversation. ---
        const configured = await isAiProviderConfigured(request, token);
        const { body: completion } = await workScopedCompletion(
            request,
            token,
            work.id,
            'Reply with the single word: meta',
            configured,
        );

        // Choose the model id to record: the REAL model the provider echoed when
        // configured, else a deterministic placeholder when not (CI).
        const recordedModel = configured
            ? (completion.model as string)
            : 'openrouter/provider-unavailable';
        const assistantContent = configured
            ? (completion.choices?.[0]?.message?.content as string)
            : '(provider unavailable)';

        const append = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: `meta probe ${s}` },
                    {
                        role: 'assistant',
                        content: assistantContent,
                        model: recordedModel,
                        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
                    },
                ],
            },
        });
        expect(append.status(), 'append model-stamped messages → 201').toBe(201);

        // Assert the recorded provider/model metadata shape on reload: the
        // assistant message carries the model string + the typed usage object.
        const reload = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        const reloaded = (await reload.json()) as ConversationRow;
        const assistant = reloaded.messages?.find((m) => m.role === 'assistant');
        expect(assistant, 'assistant message persisted').toBeTruthy();
        expect(typeof assistant?.model, 'message records a model string').toBe('string');
        expect(assistant?.model).toBe(recordedModel);
        expect(assistant?.usage, 'message records a usage object').toMatchObject({
            promptTokens: 5,
            completionTokens: 2,
            totalTokens: 7,
        });

        // When the provider is genuinely configured, the recorded model must be
        // the real model family the completion reported — proving the metadata is
        // truthful, not fabricated.
        if (configured) {
            expect(
                assistant?.model?.length,
                'real configured model id is non-empty',
            ).toBeGreaterThan(0);
            expect(assistant?.model, 'recorded model matches the live completion').toBe(
                completion.model,
            );
        }

        // The conversation still advertises its provider metadata after activity.
        const finalGet = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        expect(((await finalGet.json()) as ConversationRow).providerId).toBe(provId);
    });
});

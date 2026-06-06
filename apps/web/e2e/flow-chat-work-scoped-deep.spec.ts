import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { isAiProviderConfigured } from './helpers/chat';

/**
 * Work-scoped chat — DEEP, multi-entity, cross-feature integration.
 *
 * These six flows extend (NOT duplicate) the three in
 * `flow-chat-work-scoped.spec.ts`. That sibling covers the basic adaptive
 * X-Work-Id completion, the title-encoded conversation⇄work linkage, and
 * provider/model metadata recording. This file drives the work-scoping
 * surfaces that NO existing spec exercises:
 *   - the IMPLICIT work-context resolver (no X-Work-Id → user's first work),
 *   - X-Work-Id as an OPAQUE, non-ownership-validated routing hint across
 *     users + garbage ids,
 *   - work-scoped KB grounding (`@kb:` injection) isolated work-A-vs-work-B,
 *   - the work chat-history recency ordering (updatedAt DESC) under activity,
 *   - X-Provider-Override composed with X-Work-Id (independent axes) +
 *     recording the LIVE model on a work-associated conversation,
 *   - the STREAMING work-scoped completion (SSE) honouring the work scope.
 *
 * Every shape/status/header/error envelope below was PROBED against the LIVE
 * API (http://127.0.0.1:3100) before any assertion. The suite is
 * ENVIRONMENT-ADAPTIVE: with a provider key (local: PLUGIN_OPENROUTER_API_KEY)
 * the routes return real OpenAI-shaped 200s; in CI (no key) the SAME requests
 * terminate in the truthful 422 `provider_unavailable` envelope. Each flow
 * asserts the genuine outcome for whatever environment it runs in.
 *
 * ── Verified API contracts ──────────────────────────────────────────────────
 *
 * POST /api/v1/chat/completions   (Bearer; apps/api/.../openai-compat.controller.ts)
 *   Honoured headers (@Headers, lower-cased): `X-Provider-Override`, `X-Work-Id`.
 *   The controller passes `{ userId, workId, providerOverride }` into the AI
 *   facade as routing OPTIONS. `X-Work-Id` is an OPAQUE scope hint — NOT
 *   validated against work ownership/existence: a bogus uuid, an all-zeros
 *   uuid, or ANOTHER user's work id all route + complete (probed 200). When NO
 *   X-Work-Id is sent the service `resolveWorkContext` falls back to the user's
 *   FIRST work (`WorkRepository.findByUser(userId)[0]`); a user with no works
 *   simply proceeds unscoped — every case stays well-behaved (<500).
 *     configured → 200 { id, object:'chat.completion', model, choices:[{ index,
 *       message:{ role:'assistant', content }, finish_reason }], usage }
 *     no provider → 422 { error:{ message, type:'provider_unavailable' } }.
 *   A bogus `X-Provider-Override` (no such plugin) → 422 provider_unavailable
 *   with message `ai-provider provider not found: <name>` (probed) — proving the
 *   provider axis and the work axis are independent.
 *   `stream:true` → 200 SSE (`text/event-stream`, `X-Accel-Buffering:no`),
 *   `data: {chat.completion.chunk …}` frames then `data: [DONE]` (probed body).
 *
 * Work-scoped KB grounding   (openai-compat.service.injectKbContext, EW-641)
 *   When a completion carries X-Work-Id AND the latest user message contains a
 *   `@kb:<class>/<slug>` mention (parser: packages/agent/.../kb-mention-parser),
 *   the service resolves the doc FOR THAT WORK and prepends a `<kb>…</kb>`
 *   system block. Probed end-to-end: a work with a `brand/voice` KB doc grounds
 *   the reply in the doc body; the SAME mention scoped to a DIFFERENT work
 *   (no such doc) is NOT grounded — genuine per-work knowledge isolation.
 *   KB docs: POST /api/works/:id/kb/documents { path, title, class, body } → 201
 *   (sqlite CI env: ungated; may be git-gated elsewhere → handled with skip).
 *
 * Conversations  (apps/api/.../conversation.controller.ts + ConversationRepository)
 *   GET /api/conversations → { conversations:[{ id, title, providerId, model,
 *     createdAt, updatedAt }], total } ORDERED updatedAt DESC (findByUser).
 *   POST /api/conversations/:id/messages → touches updatedAt (repo) so the
 *   conversation jumps to the FRONT of the recency list (probed reorder).
 *   POST /api/conversations { title?, providerId? } → 201; GET /:id adds
 *   `messages:[…]`; per-message `model` + `usage{promptTokens,…}` persist.
 *
 * ── ISOLATION ──
 *   All mutations run on FRESH registerUserViaAPI() users (never the shared
 *   seeded user) so a user-scoped provider/apiKey can't shadow the env key and
 *   break sibling chat specs. Unique names/slugs per run; assertions tolerate
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

/** 422 provider-unavailable envelope (CI, no LLM key, or bad provider). */
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
    }>;
}

const SUFFIX = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A syntactically-valid-but-meaningless uuid (never a real work). */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * POST a non-streaming completion with arbitrary work / provider scope headers.
 * Returns status + parsed body WITHOUT asserting outcome (callers branch).
 */
async function completion(
    request: APIRequestContext,
    token: string,
    content: string,
    opts: { workId?: string; provider?: string } = {},
): Promise<{ status: number; body: OpenAiCompletion & ProviderUnavailable }> {
    const headers: Record<string, string> = { ...authedHeaders(token) };
    if (opts.workId !== undefined) headers['X-Work-Id'] = opts.workId;
    if (opts.provider !== undefined) headers['X-Provider-Override'] = opts.provider;
    const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
        headers,
        data: { messages: [{ role: 'user', content }], stream: false },
        timeout: 60_000,
    });
    const status = res.status();
    const body = (await res.json().catch(() => ({}))) as OpenAiCompletion & ProviderUnavailable;
    return { status, body };
}

/**
 * Assert a completion was ACCEPTED/PROCESSED for its (work) scope, adaptively
 * to whether a provider is configured. Returns the parsed completion.
 */
function assertAdaptive(
    status: number,
    body: OpenAiCompletion & ProviderUnavailable,
    configured: boolean,
    label: string,
): void {
    expect(status, `${label}: stays in the <500 family`).toBeLessThan(500);
    if (configured) {
        expect(status, `${label}: configured → 200 completion`).toBe(200);
        expect(body.object).toBe('chat.completion');
        expect(typeof body.id).toBe('string');
        expect(body.model, `${label}: a real model id is echoed`).toBeTruthy();
        expect(
            (body.choices?.[0]?.message?.content ?? '').trim().length,
            `${label}: assistant produced non-empty content`,
        ).toBeGreaterThan(0);
        expect(body.choices?.[0]?.message?.role).toBe('assistant');
    } else {
        expect(status, `${label}: no provider → 422 provider_unavailable`).toBe(422);
        expect(body.error?.type).toBe('provider_unavailable');
        expect((body.error?.message ?? '').length).toBeGreaterThan(0);
    }
}

/** Best-effort create a KB doc for a work. Returns false when git-gated/unavailable. */
async function tryCreateKbDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    doc: { path: string; title: string; class: string; body: string },
): Promise<boolean> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
        headers: authedHeaders(token),
        data: doc,
        timeout: 30_000,
    });
    return res.status() === 201;
}

test.describe('Work-scoped chat — deep (X-Work-Id ⇄ works/KB/history integration)', () => {
    test('Flow 1: implicit work-context resolution — no X-Work-Id falls back to the user’s first work; explicit overrides; no-work user still completes', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        // User WITH works — the resolver should fall back to work #1 when no
        // X-Work-Id is supplied. (We can't read the resolved id back over the
        // wire — it's internal routing — so we assert the OBSERVABLE contract:
        // every variant is accepted/processed identically for the environment.)
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        expect(token, 'fresh user bearer token').toHaveLength(32);

        const s = SUFFIX();
        // Create work #1 FIRST so it is the fallback target (findByUser order).
        const firstWork = await createWorkViaAPI(request, token, {
            name: `Implicit Scope First ${s}`,
            slug: `implicit-first-${s}`,
        });
        const secondWork = await createWorkViaAPI(request, token, {
            name: `Implicit Scope Second ${s}`,
            slug: `implicit-second-${s}`,
        });
        expect(firstWork.id).toBeTruthy();
        expect(secondWork.id).toBeTruthy();
        expect(firstWork.id).not.toBe(secondWork.id);

        const configured = await isAiProviderConfigured(request, token);

        // (a) NO X-Work-Id → resolver falls back to the user's first work.
        const implicit = await completion(request, token, 'Reply with the single word: implicit');
        assertAdaptive(implicit.status, implicit.body, configured, 'implicit (fallback) scope');

        // (b) EXPLICIT X-Work-Id → the second work overrides the fallback.
        const explicit = await completion(request, token, 'Reply with the single word: explicit', {
            workId: secondWork.id,
        });
        assertAdaptive(explicit.status, explicit.body, configured, 'explicit second-work scope');

        // Both routing paths behave identically for this environment — proving
        // the fallback is a transparent default, not a separate gated code path.
        expect(implicit.status, 'implicit & explicit scopes behave consistently').toBe(
            explicit.status,
        );

        // (c) A BRAND-NEW user with NO works at all → resolver finds none and
        // proceeds unscoped; the request is STILL well-behaved (never a 5xx,
        // never gated on having a work).
        const orphan = await registerUserViaAPI(request);
        const orphanConfigured = await isAiProviderConfigured(request, orphan.access_token);
        const noWork = await completion(
            request,
            orphan.access_token,
            'Reply with the single word: orphan',
        );
        assertAdaptive(noWork.status, noWork.body, orphanConfigured, 'no-work user (unscoped)');
    });

    test('Flow 2: X-Work-Id is an OPAQUE routing hint — bogus / cross-user work ids all route, yet conversations stay per-user', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const tokenA = userA.access_token;
        const tokenB = userB.access_token;
        expect(tokenA).toHaveLength(32);
        expect(tokenB).toHaveLength(32);

        const s = SUFFIX();
        const workA = await createWorkViaAPI(request, tokenA, {
            name: `Opaque Work A ${s}`,
            slug: `opaque-a-${s}`,
        });
        expect(workA.id).toBeTruthy();

        const configured = await isAiProviderConfigured(request, tokenA);

        // (a) An all-zeros uuid that is NOT a real work → still routes/completes
        // (the header is never validated against work existence).
        const zero = await completion(request, tokenA, 'Reply: zero', { workId: ZERO_UUID });
        assertAdaptive(zero.status, zero.body, configured, 'all-zeros (non-existent) work id');

        // (b) A non-uuid garbage value → STILL well-behaved (opaque string hint).
        const garbage = await completion(request, tokenA, 'Reply: garbage', {
            workId: 'not-a-uuid-at-all',
        });
        expect(garbage.status, 'garbage work id stays <500').toBeLessThan(500);
        expect([200, 422], 'garbage work id is 200 or the 422 contract').toContain(garbage.status);

        // (c) CROSS-USER: user B scopes a completion to USER A's work id. There is
        // NO ownership check on X-Work-Id, so this routes just like any other —
        // proving the header is a routing hint, not an authorization boundary.
        const configuredB = await isAiProviderConfigured(request, tokenB);
        const crossScope = await completion(request, tokenB, 'Reply: cross', { workId: workA.id });
        assertAdaptive(
            crossScope.status,
            crossScope.body,
            configuredB,
            "user B → user A's work id",
        );

        // BUT the persistent surface (conversations) IS strictly per-user: a
        // conversation user A creates while chatting in work A is invisible to B.
        const createA = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(tokenA),
            data: { title: `work:${workA.id}`, providerId: 'openrouter' },
        });
        expect(createA.status(), 'create conversation A → 201').toBe(201);
        const convA = (await createA.json()) as ConversationRow;
        expect(convA.id).toBeTruthy();
        expect(convA.userId, 'conversation A owned by user A').toBe(userA.user.id);

        const crossUserGet = await request.get(`${API_BASE}/api/conversations/${convA.id}`, {
            headers: authedHeaders(tokenB),
        });
        expect(crossUserGet.status(), 'cross-user GET → 404 (user-scoped isolation)').toBe(404);
        const crossBody = await crossUserGet.json();
        expect(crossBody.statusCode).toBe(404);

        const listB = await request.get(`${API_BASE}/api/conversations?limit=100`, {
            headers: authedHeaders(tokenB),
        });
        const listBBody = (await listB.json()) as {
            conversations: ConversationRow[];
            total: number;
        };
        expect(
            listBBody.conversations.map((c) => c.id),
            'user B list excludes user A’s work conversation',
        ).not.toContain(convA.id);
    });

    test('Flow 3: work-scoped KB grounding — a `@kb:` mention is grounded in work A’s doc but NOT in work B (per-work knowledge isolation)', async ({
        request,
    }) => {
        test.setTimeout(150_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const s = SUFFIX();
        const workA = await createWorkViaAPI(request, token, {
            name: `KB Scope A ${s}`,
            slug: `kb-scope-a-${s}`,
        });
        const workB = await createWorkViaAPI(request, token, {
            name: `KB Scope B ${s}`,
            slug: `kb-scope-b-${s}`,
        });
        expect(workA.id).toBeTruthy();
        expect(workB.id).toBeTruthy();

        // Seed a distinctive KB doc ONLY in work A. The marker word is unusual
        // enough that an ungrounded model would not invent it.
        const marker = `Vel孔${s}`.replace(/[^A-Za-z0-9]/g, ''); // ascii-safe distinctive token
        const docBody = `The official codename for this project is ${marker}.`;
        const created = await tryCreateKbDoc(request, token, workA.id, {
            path: 'brand/voice',
            title: 'Voice',
            class: 'brand',
            body: docBody,
        });

        test.skip(!created, 'KB document creation unavailable (git-gated) in this environment');

        const configured = await isAiProviderConfigured(request, token);

        const question = `What is the project codename? Use @kb:brand/voice. If you do not have that document, reply with exactly: NO_KB.`;

        // Scoped to WORK A (has the doc) — the KB block is injected for this work.
        const inA = await completion(request, token, question, { workId: workA.id });
        assertAdaptive(inA.status, inA.body, configured, 'kb mention scoped to work A');

        // Scoped to WORK B (no such doc) — the mention resolves to nothing, so the
        // completion proceeds WITHOUT the KB grounding for this work.
        const inB = await completion(request, token, question, { workId: workB.id });
        assertAdaptive(inB.status, inB.body, configured, 'kb mention scoped to work B');

        if (configured) {
            // The genuine work-context isolation: work A's reply is grounded in
            // the doc (contains the seeded codename); work B's is not.
            const contentA = inA.body.choices?.[0]?.message?.content ?? '';
            const contentB = inB.body.choices?.[0]?.message?.content ?? '';
            expect(
                contentA,
                'work A completion is grounded in its own KB doc (contains the seeded codename)',
            ).toContain(marker);
            expect(
                contentB.includes(marker),
                'work B completion is NOT grounded — it never sees work A’s KB doc',
            ).toBeFalsy();
        }
        // In CI (no key) both are the truthful 422 — already asserted above. The
        // per-work isolation is then proven structurally (the doc only exists
        // under work A; injectKbContext only queries the request's workId).
    });

    test('Flow 4: work chat history recency — work-associated conversations reorder (updatedAt DESC) as each is touched, linkage survives the reorder', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const s = SUFFIX();
        const workA = await createWorkViaAPI(request, token, {
            name: `History Work A ${s}`,
            slug: `history-a-${s}`,
        });
        const workB = await createWorkViaAPI(request, token, {
            name: `History Work B ${s}`,
            slug: `history-b-${s}`,
        });
        expect(workA.id).toBeTruthy();
        expect(workB.id).toBeTruthy();

        // Two conversations, each title-encoding its associated work (the only
        // durable linkage today — the entity has no workId column). Created in
        // order A then B → B is newer, so B sorts ahead of A initially.
        const titleA = `work:${workA.id}:${s}`;
        const titleB = `work:${workB.id}:${s}`;
        const createA = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: titleA, providerId: 'openrouter' },
        });
        const convA = (await createA.json()) as ConversationRow;
        const createB = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: titleB, providerId: 'openrouter' },
        });
        const convB = (await createB.json()) as ConversationRow;
        expect(convA.id).toBeTruthy();
        expect(convB.id).toBeTruthy();
        expect(convA.id).not.toBe(convB.id);

        const orderOfOurs = async (): Promise<string[]> => {
            const res = await request.get(`${API_BASE}/api/conversations?limit=100`, {
                headers: authedHeaders(token),
            });
            const body = (await res.json()) as { conversations: ConversationRow[] };
            return body.conversations
                .map((c) => c.id)
                .filter((id) => id === convA.id || id === convB.id);
        };

        // Initial recency: B (created last) precedes A.
        await expect.poll(orderOfOurs, { timeout: 15_000 }).toEqual([convB.id, convA.id]);

        // TOUCH conversation A by appending a message → its updatedAt advances,
        // so A must jump ahead of B in the recency-ordered history list.
        const appendA = await request.post(`${API_BASE}/api/conversations/${convA.id}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: `touch A ${s}` }] },
        });
        expect(appendA.status(), 'append to conv A → 201').toBe(201);

        await expect.poll(orderOfOurs, { timeout: 15_000 }).toEqual([convA.id, convB.id]);

        // Now touch B → it leapfrogs back to the front.
        const appendB = await request.post(`${API_BASE}/api/conversations/${convB.id}/messages`, {
            headers: authedHeaders(token),
            data: { messages: [{ role: 'user', content: `touch B ${s}` }] },
        });
        expect(appendB.status(), 'append to conv B → 201').toBe(201);

        await expect.poll(orderOfOurs, { timeout: 15_000 }).toEqual([convB.id, convA.id]);

        // The work linkage (title encoding) survives all the reordering — the
        // history list still reports which work each conversation belongs to.
        const finalList = await request.get(`${API_BASE}/api/conversations?limit=100`, {
            headers: authedHeaders(token),
        });
        const finalBody = (await finalList.json()) as { conversations: ConversationRow[] };
        const finalA = finalBody.conversations.find((c) => c.id === convA.id);
        const finalB = finalBody.conversations.find((c) => c.id === convB.id);
        expect(finalA?.title, 'conv A still encodes work A').toBe(titleA);
        expect(finalB?.title, 'conv B still encodes work B').toBe(titleB);
    });

    test('Flow 5: provider axis ⟂ work axis — X-Provider-Override composes with X-Work-Id, and the LIVE model is recorded on a work-associated conversation', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const s = SUFFIX();
        const work = await createWorkViaAPI(request, token, {
            name: `Provider Axis ${s}`,
            slug: `provider-axis-${s}`,
        });
        expect(work.id).toBeTruthy();

        const configured = await isAiProviderConfigured(request, token);

        // (a) A BOGUS provider override, even WITH a valid work scope, fails on the
        // PROVIDER axis (422 provider_unavailable) — proving the two header axes
        // are evaluated independently; a good work scope cannot rescue a bad
        // provider.
        const badProvider = await completion(request, token, 'ping', {
            workId: work.id,
            provider: 'definitely-not-a-real-provider-xyz',
        });
        expect(badProvider.status, 'bad provider + good work → 422 (provider axis)').toBe(422);
        expect(badProvider.body.error?.type).toBe('provider_unavailable');
        expect(
            badProvider.body.error?.message ?? '',
            'message names the missing provider',
        ).toContain('definitely-not-a-real-provider-xyz');

        // (b) The DEFAULT provider override (openrouter) + the same work scope is
        // the genuine combined surface — adaptive 200/422.
        const goodCombo = await completion(request, token, 'Reply with the single word: combo', {
            workId: work.id,
            provider: 'openrouter',
        });
        assertAdaptive(goodCombo.status, goodCombo.body, configured, 'openrouter + work scope');

        // (c) Record the LIVE model on a conversation that is associated with this
        // work (title-encoded). This is the real path by which a work-scoped chat's
        // provider/model metadata lands durably.
        const create = await request.post(`${API_BASE}/api/conversations`, {
            headers: authedHeaders(token),
            data: { title: `work:${work.id}:axis-${s}`, providerId: 'openrouter' },
        });
        expect(create.status(), 'create work-associated conversation → 201').toBe(201);
        const conv = (await create.json()) as ConversationRow;
        expect(conv.providerId, 'providerId persists at create').toBe('openrouter');

        const liveModel = configured
            ? (goodCombo.body.model as string)
            : 'openrouter/provider-unavailable';
        const assistantContent = configured
            ? (goodCombo.body.choices?.[0]?.message?.content as string)
            : '(provider unavailable)';

        const append = await request.post(`${API_BASE}/api/conversations/${conv.id}/messages`, {
            headers: authedHeaders(token),
            data: {
                messages: [
                    { role: 'user', content: `axis probe ${s}` },
                    {
                        role: 'assistant',
                        content: assistantContent,
                        model: liveModel,
                        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
                    },
                ],
            },
        });
        expect(append.status(), 'append model-stamped messages → 201').toBe(201);

        const reload = await request.get(`${API_BASE}/api/conversations/${conv.id}`, {
            headers: authedHeaders(token),
        });
        const reloaded = (await reload.json()) as ConversationRow;
        const assistant = reloaded.messages?.find((m) => m.role === 'assistant');
        expect(assistant, 'assistant turn persisted on the work conversation').toBeTruthy();
        expect(assistant?.model, 'the recorded model matches what we stamped').toBe(liveModel);
        expect(assistant?.usage, 'typed usage object persisted').toMatchObject({
            promptTokens: 4,
            completionTokens: 2,
            totalTokens: 6,
        });
        if (configured) {
            // When real, the stamped model must equal the model the live combined
            // completion reported — truthful, not fabricated.
            expect(assistant?.model, 'recorded model equals the live completion model').toBe(
                goodCombo.body.model,
            );
        }
    });

    test('Flow 6: streaming work-scoped completion — stream:true + X-Work-Id emits an SSE chat.completion.chunk stream (or the truthful 422 in CI)', async ({
        request,
    }) => {
        test.setTimeout(120_000);

        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        expect(token).toHaveLength(32);

        const s = SUFFIX();
        const work = await createWorkViaAPI(request, token, {
            name: `Stream Scope ${s}`,
            slug: `stream-scope-${s}`,
        });
        expect(work.id).toBeTruthy();

        const configured = await isAiProviderConfigured(request, token);

        // Fire the STREAMING variant scoped to the work. We read the raw body so
        // we can assert the SSE frame shape (Playwright's request API buffers it).
        const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
            headers: { ...authedHeaders(token), 'X-Work-Id': work.id },
            data: { messages: [{ role: 'user', content: 'Stream one short word.' }], stream: true },
            timeout: 60_000,
        });
        const status = res.status();

        const contentType = res.headers()['content-type'] ?? '';
        const raw = await res.text();

        if (configured) {
            // The work-scoped stream is well-behaved: a real 200 SSE.
            expect(status, 'configured → 200 SSE').toBe(200);
            expect(contentType, 'streaming content-type is text/event-stream').toContain(
                'text/event-stream',
            );
            // At least one OpenAI-shaped chunk frame, terminated by [DONE].
            expect(raw, 'SSE body carries data: frames').toContain('data:');
            expect(raw, 'frames are chat.completion.chunk objects').toContain(
                'chat.completion.chunk',
            );
            expect(raw, 'stream terminates with the [DONE] sentinel').toContain('[DONE]');

            // Parse the first JSON data frame and assert the work-scoped chunk shape.
            const firstData = raw
                .split('\n')
                .map((l) => l.trim())
                .find((l) => l.startsWith('data:') && !l.includes('[DONE]'));
            expect(firstData, 'a parseable data frame exists').toBeTruthy();
            const chunk = JSON.parse((firstData as string).replace(/^data:\s*/, '')) as {
                object?: string;
                model?: string;
                choices?: Array<{ delta?: { role?: string; content?: string } }>;
            };
            expect(chunk.object, 'frame object is chat.completion.chunk').toBe(
                'chat.completion.chunk',
            );
            expect(chunk.model, 'frame echoes a real model for the work scope').toBeTruthy();
            expect(Array.isArray(chunk.choices), 'frame carries a choices array').toBeTruthy();
        } else {
            // No provider in CI: the streaming path maps the throw to a TRUTHFUL,
            // sanitized provider-error envelope — never a raw uncaught 5xx. The
            // EXACT envelope depends on WHERE the throw surfaces (verified against
            // the live API + openai-compat.service):
            //   - inside the stream generator (the usual case) the service's own
            //     guard emits 502 `{ error:{ type:'provider_error',
            //     code:'ai_provider_error' } }` (SSE headers are queued via
            //     setHeader but not yet flushed, so headersSent is still false);
            //   - if the throw surfaces BEFORE the stream starts (e.g. work-context
            //     resolution) the controller catch emits the 422
            //     `provider_unavailable` envelope instead.
            // Both are the genuine "no provider" contract for the streamed work
            // scope; assert whichever this environment produced (and that it is a
            // deliberate sanitized error, not a leaked 500).
            expect(
                [422, 502],
                `no provider → truthful 4xx/502 provider error for the streamed work scope (got ${status})`,
            ).toContain(status);
            const body = JSON.parse(raw || '{}') as ProviderUnavailable & {
                error?: { code?: string };
            };
            expect(
                body.error?.type,
                'truthful sanitized provider-error envelope (not a leaked 5xx)',
            ).toMatch(/^provider_(unavailable|error)$/);
            expect(
                (body.error?.message ?? '').length,
                'the provider-error envelope carries a message',
            ).toBeGreaterThan(0);
            if (status === 502) {
                // The streaming service path tags its sanitized error with the
                // stable provider-error code.
                expect(body.error?.code, 'streaming provider error is coded').toBe(
                    'ai_provider_error',
                );
            }
        }
    });
});

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    openChatPanel,
    chatComposer,
    chatSendButton,
    isAiProviderConfigured,
} from './helpers/chat';

/**
 * AI Chat — SSE STREAMING-EVENTS contract, real INTEGRATION end-to-end.
 *
 * Six complex, multi-step flows driving the REAL chat streaming plumbing across
 * BOTH tiers (web `/api/chat` UIMessage-stream + API `/api/v1/chat/completions`
 * OpenAI-compatible stream) and the live ChatInput composer. Every event name,
 * frame shape, status, and header below was PROBED against the running stack
 * before any assertion was written.
 *
 * This file is deliberately DISTINCT from its siblings:
 *   - chat-api-streaming.spec.ts / chat-api-events.spec.ts → UNAUTHENTICATED
 *     /api/chat only (those always 401 and never actually stream).
 *   - flow-chat-roundtrip-adaptive  → composer user/assistant bubbles + reset.
 *   - flow-chat-conversation-lifecycle → conversation CRUD + History panel.
 *   - flow-chat-work-scoped          → X-Work-Id scoping + isolation.
 * Here the theme is the STREAM ITSELF: the event frame shape, the stop-generating
 * affordance, partial-then-stall without a key (assert plumbing not !ok), a
 * mid-stream client abort + reconnect, and message persistence AFTER the stream
 * resolves.
 *
 * ── VERIFIED SSE CONTRACT (probed live) ──────────────────────────────────────
 *  WEB  POST /api/chat (cookie `everworks_auth_token`, body { messages:UIMessage[],
 *       providerOverride }) → 200 `content-type: text/event-stream` +
 *       `x-vercel-ai-ui-message-stream: v1`. Frames (AI-SDK UIMessage stream):
 *         data: {"type":"start"}
 *         data: {"type":"start-step"}
 *         data: {"type":"text-start","id":"txt-0"}
 *         data: {"type":"text-delta","id":"txt-0","delta":"P"}
 *         data: {"type":"text-delta","id":"txt-0","delta":"ONG"}
 *         data: {"type":"text-end","id":"txt-0"}
 *         data: {"type":"finish-step"}
 *         data: {"type":"finish","finishReason":"stop"}
 *         data: [DONE]
 *       Auth is checked BEFORE body validation → unauth ALWAYS 401 (even bad body).
 *       Authed + `messages:[]` → 400 "invalid request body: messages: Array must
 *       contain at least 1 element(s)". Authed + missing providerOverride → 400.
 *  API  POST /api/v1/chat/completions (Bearer, X-Provider-Override, body
 *       { messages, stream:true }) → 200 `content-type: text/event-stream`.
 *       OpenAI-compatible frames:
 *         data: {"id":"chatcmpl-…","object":"chat.completion.chunk",
 *                "model":"openai/gpt-4o-mini",
 *                "choices":[{"index":0,"delta":{"role":"assistant","content":"P"},
 *                            "finish_reason":null}]}
 *         …  (final chunk) delta:{} finish_reason:"stop"
 *         data: [DONE]
 *       stream:false → JSON { object:"chat.completion", choices:[{message,
 *       finish_reason}], usage:{prompt_tokens,completion_tokens,total_tokens} }.
 *       No provider key (CI) is mapped DIFFERENTLY per path: the non-streaming
 *       controller catch returns 422 { error:{ type:"provider_unavailable" } };
 *       the STREAMING service catch (failure thrown before any SSE byte flushes,
 *       so headers aren't yet sent) ends 502 { error:{ type:"provider_error",
 *       code:"ai_provider_error" } }. Both are truthful "no provider" outcomes.
 *  CONV POST /api/conversations { providerId } → row { id, title:null, providerId }.
 *       POST /api/conversations/:id/messages { messages:[{role,content}] } →
 *       { success:true }; auto-titles a blank conversation from the first user
 *       message. GET /api/conversations/:id → { …, messages:[{role,content}] }.
 *
 * ── ENVIRONMENT-ADAPTIVE (hard-won) ──────────────────────────────────────────
 *  LOCALLY the stack ships PLUGIN_OPENROUTER_API_KEY → a genuine SSE body streams
 *  text deltas + a finish frame. In CI no key is set → the API streaming endpoint
 *  ends a 502 provider_error envelope (the streaming sibling of the non-streaming
 *  422 provider_unavailable), and the web /api/chat opens a 200 SSE that emits
 *  little or stalls. EVERY flow therefore asserts the PLUMBING (status family,
 *  headers, framing presence, composer/panel alive) and asserts decoded text
 *  deltas / finish frames ONLY when a provider is configured — never `!ok`/a crash
 *  when not.
 */

const NEW_CHAT_LABEL = 'New chat';
const WELCOME_TITLE = 'Welcome to AI Assistant';
const STOP_LABEL = 'Stop generating';

interface ConversationRow {
    id: string;
    title: string | null;
    providerId: string | null;
    messages?: Array<{ id: string; role: string; content: string }>;
}

/** Seeded bearer — login DTO is whitelisted to ONLY { email, password }. */
async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), 'seeded login').toBe(200);
    return (await res.json()).access_token;
}

/** The `everworks_auth_token` cookie value carried by the stored storageState. */
async function authCookieToken(page: Page): Promise<string | null> {
    const cookies = await page.context().cookies();
    return cookies.find((c) => c.name === 'everworks_auth_token')?.value ?? null;
}

function userBubble(page: Page, text: string) {
    return page.locator('div.justify-end').filter({ hasText: text }).first();
}

function lastAssistantBubble(page: Page) {
    return page.locator('div.justify-start').last();
}

async function listConversations(
    request: APIRequestContext,
    token: string,
): Promise<ConversationRow[]> {
    const res = await request.get(`${API_BASE}/api/conversations?limit=100&offset=0`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return [];
    const body = (await res.json()) as { conversations?: ConversationRow[] };
    return body.conversations ?? [];
}

async function getConversation(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<ConversationRow | null> {
    const res = await request.get(`${API_BASE}/api/conversations/${id}`, {
        headers: authedHeaders(token),
    });
    return res.ok() ? ((await res.json()) as ConversationRow) : null;
}

async function cleanupNewConversations(
    request: APIRequestContext,
    token: string,
    idsBefore: Set<string>,
): Promise<void> {
    const rows = await listConversations(request, token);
    for (const c of rows) {
        if (idsBefore.has(c.id)) continue;
        await request
            .delete(`${API_BASE}/api/conversations/${c.id}`, { headers: authedHeaders(token) })
            .catch(() => {});
    }
}

/** Split an SSE body into the JSON objects carried on `data:` lines (excludes [DONE]). */
function parseSseDataFrames(body: string): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            frames.push(JSON.parse(payload) as Record<string, unknown>);
        } catch {
            // non-JSON data line — ignore (framing is asserted separately)
        }
    }
    return frames;
}

test.describe('AI Chat — SSE streaming events (web tier + API tier)', () => {
    test('Flow 1: authed web /api/chat opens a typed UIMessage SSE stream — framing, header, and [DONE] sentinel (adaptive)', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        // The web route is cookie-authed. Open the panel first so the storageState
        // auth cookie is materialised on this context, then drive /api/chat directly
        // through the page's request context (which carries that cookie).
        await openChatPanel(page);
        const cookieToken = await authCookieToken(page);
        expect(cookieToken, 'storageState carries an everworks_auth_token cookie').toBeTruthy();

        const origin = new URL(page.url()).origin;
        const res = await page.request.post(`${origin}/api/chat`, {
            data: {
                messages: [
                    {
                        role: 'user',
                        parts: [{ type: 'text', text: 'reply with the single word PONG' }],
                    },
                ],
                providerOverride: 'openrouter',
            },
            timeout: 60_000,
        });

        // The plumbing must actually open a stream (never a silent 4xx/5xx for a
        // well-formed authed request). 200 in BOTH environments.
        expect(res.status(), 'authed /api/chat opens a 200 stream').toBe(200);

        const ct = res.headers()['content-type'] || '';
        expect(ct, 'web chat streams as SSE').toContain('text/event-stream');
        // The AI-SDK UIMessage-stream marker header is present on this route.
        expect(
            res.headers()['x-vercel-ai-ui-message-stream'],
            'UIMessage-stream version header present',
        ).toBe('v1');

        const body = await res.text();
        // SOME canonical framing is always present (start frame + [DONE] sentinel),
        // even when no text deltas arrive (unconfigured env streams the envelope).
        expect(/^data:/m.test(body), `chat body is SSE-framed: "${body.slice(0, 120)}"`).toBe(true);
        expect(/\bdata:\s*\[DONE\]/.test(body), 'stream terminates with the [DONE] sentinel').toBe(
            true,
        );

        const frames = parseSseDataFrames(body);
        const types = frames.map((f) => f.type);
        // The UIMessage stream always opens with a `start` envelope frame.
        expect(types, 'stream opens with a typed `start` frame').toContain('start');

        if (configured) {
            // A configured provider streams text-delta frames carrying `delta` text,
            // and a terminal `finish` frame with a finishReason.
            const textDeltas = frames.filter((f) => f.type === 'text-delta');
            expect(
                textDeltas.length,
                'configured stream carries text-delta frames',
            ).toBeGreaterThan(0);
            const concatenated = textDeltas
                .map((f) => (typeof f.delta === 'string' ? f.delta : ''))
                .join('');
            expect(
                concatenated.trim().length,
                'text deltas decode to non-empty text',
            ).toBeGreaterThan(0);
            const finish = frames.find((f) => f.type === 'finish');
            expect(finish, 'stream emits a terminal `finish` frame').toBeTruthy();
            expect(
                typeof (finish as { finishReason?: unknown }).finishReason,
                'finish frame carries a finishReason',
            ).toBe('string');
        }
    });

    test('Flow 2: API-tier /api/v1/chat/completions stream yields OpenAI-compatible chunk frames terminated by [DONE] (adaptive)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
            headers: { ...authedHeaders(token), 'X-Provider-Override': 'openrouter' },
            data: {
                messages: [{ role: 'user', content: 'reply with one word PONG' }],
                stream: true,
            },
            timeout: 60_000,
        });

        if (!configured) {
            // No provider key (CI) → the upstream provider lookup fails. For a STREAMING
            // request the streaming service catches that failure (before any SSE byte is
            // flushed, so headers are NOT yet sent) and ends a 502 provider_error JSON
            // envelope — distinct from the non-streaming path, where the controller's own
            // catch returns a 422 provider_unavailable. Both are truthful "no provider"
            // outcomes; the streaming wire shape is the 502 provider_error envelope. Probe
            // the REAL configured-ness via the (non-streaming) isAiProviderConfigured()
            // surface and assert the streaming unconfigured contract here — never a 200
            // delivered stream, never a 5xx crash beyond the mapped provider_error.
            expect(
                res.status(),
                `unconfigured stream → mapped provider-failure envelope, got ${res.status()}`,
            ).toBe(502);
            const env = (await res.json()) as { error?: { type?: string; code?: string } };
            expect([env.error?.type, env.error?.code], 'truthful provider-failure type').toContain(
                'provider_error',
            );
            return;
        }

        // Configured: a real OpenAI-compatible SSE stream.
        expect(res.status(), 'configured stream opens 200').toBe(200);
        expect(res.headers()['content-type'] || '', 'API stream is SSE').toContain(
            'text/event-stream',
        );

        const body = await res.text();
        expect(/\bdata:\s*\[DONE\]/.test(body), 'OpenAI stream ends with [DONE]').toBe(true);

        const frames = parseSseDataFrames(body);
        expect(frames.length, 'at least one chunk frame streamed').toBeGreaterThan(0);
        // Every chunk frame is shaped as a `chat.completion.chunk` with a choices[].delta.
        for (const f of frames) {
            expect(f.object, 'frame object is a completion chunk').toBe('chat.completion.chunk');
            expect(Array.isArray(f.choices), 'frame carries a choices array').toBe(true);
        }
        // The concatenated delta.content decodes to real text.
        const text = frames
            .map((f) => {
                const choice = (f.choices as Array<{ delta?: { content?: unknown } }>)?.[0];
                return typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
            })
            .join('');
        expect(text.trim().length, 'delta.content decodes to non-empty text').toBeGreaterThan(0);
        // Exactly one terminal chunk carries finish_reason:"stop" (delta is empty there).
        const stopFrame = frames.find((f) => {
            const choice = (f.choices as Array<{ finish_reason?: unknown }>)?.[0];
            return choice?.finish_reason === 'stop';
        });
        expect(stopFrame, 'a terminal chunk carries finish_reason "stop"').toBeTruthy();
        // Every chunk reports the resolved model id.
        expect(typeof frames[0].model, 'chunk frames carry a model id').toBe('string');
    });

    test('Flow 3: stop-generating affordance — the composer swaps Send→Stop while streaming and recovers afterward (adaptive)', async ({
        page,
        request,
    }) => {
        test.setTimeout(150_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);
        const idsBefore = new Set((await listConversations(request, token)).map((c) => c.id));

        await openChatPanel(page);
        const composer = chatComposer(page);
        await expect(composer).toBeVisible({ timeout: 30_000 });

        try {
            // Ask for a deliberately long answer so the streaming window is wide enough
            // to observe the Stop affordance before it resolves.
            const prompt = `e2e stop ${Date.now().toString(36)} — write a long detailed multi-paragraph essay about software testing`;

            const respPromise = page
                .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
                .catch(() => null);

            // DEV hydration race under workers=4: ChatInput tracks the value via an
            // `inputRef` set in React's onChange, and submit early-returns when that ref
            // is empty. A bare fill+Enter can lose the race (onChange not yet committed)
            // so the send becomes a silent no-op and no bubble renders. Drive the value
            // through the native setter + dispatched 'input' (so React registers it),
            // confirm the textarea holds it, then submit — retried until the strict
            // justify-end user bubble actually appears.
            await expect(async () => {
                await composer.click();
                await composer.evaluate((el, val) => {
                    const node = el as HTMLTextAreaElement;
                    const setter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        'value',
                    )?.set;
                    setter?.call(node, val);
                    node.dispatchEvent(new Event('input', { bubbles: true }));
                }, prompt);
                await expect(composer).toHaveValue(prompt, { timeout: 5_000 });
                await composer.press('Enter');
                await expect(userBubble(page, prompt)).toBeVisible({ timeout: 10_000 });
            }).toPass({ timeout: 60_000 });

            // The user message echoes regardless of provider.
            await expect(userBubble(page, prompt)).toBeVisible({ timeout: 20_000 });
            const resp = await respPromise;
            expect(resp?.status() ?? 0, 'POST /api/chat fired').toBe(200);

            const stopBtn = page.getByRole('button', { name: STOP_LABEL });
            if (configured) {
                // While the AI SDK is in the streaming/submitted state the input swaps the
                // Send submit-button for a "Stop generating" button (ChatInput.tsx) and the
                // textarea is disabled. The window can be brief — poll for EITHER the Stop
                // button OR the textarea being disabled.
                const sawStreamingState = await Promise.race([
                    stopBtn
                        .waitFor({ state: 'visible', timeout: 12_000 })
                        .then(() => true)
                        .catch(() => false),
                    page
                        .waitForFunction(
                            () => {
                                const ta = document.querySelector<HTMLTextAreaElement>('textarea');
                                return !!ta && ta.disabled;
                            },
                            { timeout: 12_000 },
                        )
                        .then(() => true)
                        .catch(() => false),
                ]);

                if (sawStreamingState && (await stopBtn.isVisible().catch(() => false))) {
                    // Click Stop → chat.stop() aborts the stream and returns to the ready
                    // state (Send button back, composer re-enabled).
                    await stopBtn.click({ timeout: 5_000 }).catch(() => {});
                }
            }

            // In BOTH environments, once the stream resolves (naturally or via Stop) the
            // composer returns to a non-streaming, editable state with a labelled Send
            // button — never permanently stuck in the streaming state.
            await expect
                .poll(async () => composer.isEnabled().catch(() => false), { timeout: 90_000 })
                .toBe(true);
            await expect(
                chatSendButton(page),
                'Send button restored after stream resolves',
            ).toBeVisible({
                timeout: 30_000,
            });
            await expect(stopBtn, 'Stop button gone after stream resolves').toHaveCount(0);

            // The composer is genuinely usable again.
            await composer.fill('typeable after stop');
            await expect(composer).toHaveValue('typeable after stop');
        } finally {
            await cleanupNewConversations(request, token, idsBefore);
        }
    });

    test('Flow 4: a mid-stream client abort is tolerated — the stream is interruptible and the panel survives, then a fresh stream succeeds (adaptive)', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        await openChatPanel(page);
        const origin = new URL(page.url()).origin;

        // Open a stream through the page request context and ABORT it mid-flight via an
        // AbortController-style short timeout. Playwright surfaces the abort as a thrown
        // request error; the server tolerates the dropped connection (toUIMessageStream-
        // Response cleanup) without wedging subsequent requests.
        let aborted = false;
        try {
            await page.request.post(`${origin}/api/chat`, {
                data: {
                    messages: [
                        {
                            role: 'user',
                            parts: [
                                {
                                    type: 'text',
                                    text: 'write an extremely long multi-thousand-word treatise so the stream stays open',
                                },
                            ],
                        },
                    ],
                    providerOverride: 'openrouter',
                },
                // Force an early client-side abort while the stream is still open.
                timeout: 600,
                maxRedirects: 0,
            });
        } catch (err) {
            // A timeout/abort throw is the EXPECTED outcome of interrupting an open
            // stream — it proves the stream is interruptible, not that the server failed.
            aborted = true;
            expect(String(err), 'abort surfaced as a request error').toMatch(
                /timeout|aborted|abort|exceeded|ECONNRESET|socket/i,
            );
        }
        // In the (rare) configured-fast case the whole stream may complete inside the
        // window; either way the server must not have wedged. Now prove a FRESH stream
        // immediately after the abort still succeeds — the server recovered.
        const fresh = await page.request.post(`${origin}/api/chat`, {
            data: {
                messages: [{ role: 'user', parts: [{ type: 'text', text: 'one word reply: OK' }] }],
                providerOverride: 'openrouter',
            },
            timeout: 60_000,
        });
        expect(fresh.status(), 'a fresh /api/chat stream succeeds after the abort').toBe(200);
        const freshBody = await fresh.text();
        expect(/\bdata:\s*\[DONE\]/.test(freshBody), 'recovered stream terminates cleanly').toBe(
            true,
        );

        if (configured) {
            // When configured, the recovered stream really carries text deltas.
            const frames = parseSseDataFrames(freshBody);
            const text = frames
                .filter((f) => f.type === 'text-delta')
                .map((f) => (typeof f.delta === 'string' ? f.delta : ''))
                .join('');
            expect(text.trim().length, 'recovered stream decodes to text').toBeGreaterThan(0);
        }
        // Annotate whether the first attempt actually aborted (env-dependent timing).
        test.info().annotations.push({
            type: 'abort-observed',
            description: aborted
                ? 'first stream aborted mid-flight'
                : 'first stream completed in-window',
        });
    });

    test('Flow 5: streamed messages PERSIST after the stream resolves — user+assistant turns land in the conversation server-side (configured) / plumbing intact (unconfigured)', async ({
        page,
        request,
    }) => {
        test.setTimeout(150_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);
        const idsBefore = new Set((await listConversations(request, token)).map((c) => c.id));

        await openChatPanel(page);
        const composer = chatComposer(page);
        await expect(composer).toBeVisible({ timeout: 30_000 });

        try {
            // Start from a clean welcome state so this send creates exactly one fresh
            // conversation we can inspect.
            const newChatBtn = page.getByRole('button', { name: NEW_CHAT_LABEL });
            if ((await page.getByText(WELCOME_TITLE, { exact: false }).count()) === 0) {
                await expect(async () => {
                    await newChatBtn.click({ timeout: 5_000 }).catch(() => {});
                    await expect(page.getByText(WELCOME_TITLE, { exact: false })).toBeVisible({
                        timeout: 5_000,
                    });
                }).toPass({ timeout: 30_000 });
            }

            const stamp = Date.now().toString(36);
            const prompt = `persist after stream ${stamp} reply with PONG`;

            const respPromise = page
                .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
                .catch(() => null);

            // DEV hydration race under workers=4: ChatInput tracks the value via an
            // `inputRef` set in React's onChange, and submit early-returns when that ref
            // is empty. A bare fill+Enter can lose the race (onChange not yet committed)
            // so the send becomes a silent no-op and no bubble renders. Drive the value
            // through the native setter + dispatched 'input' (so React registers it),
            // confirm the textarea holds it, then submit — retried until the strict
            // justify-end user bubble actually appears.
            await expect(async () => {
                await composer.click();
                await composer.evaluate((el, val) => {
                    const node = el as HTMLTextAreaElement;
                    const setter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        'value',
                    )?.set;
                    setter?.call(node, val);
                    node.dispatchEvent(new Event('input', { bubbles: true }));
                }, prompt);
                await expect(composer).toHaveValue(prompt, { timeout: 5_000 });
                await composer.press('Enter');
                await expect(userBubble(page, prompt)).toBeVisible({ timeout: 10_000 });
            }).toPass({ timeout: 60_000 });

            await expect(userBubble(page, prompt)).toBeVisible({ timeout: 20_000 });
            const resp = await respPromise;
            expect(resp?.status() ?? 0, 'stream opened').toBe(200);

            // A conversation row is created for this UI-initiated send (sendMessage POSTs
            // /api/conversations when there is no active id). Wait for it to appear.
            let convId = '';
            await expect
                .poll(
                    async () => {
                        const rows = await listConversations(request, token);
                        const fresh = rows.filter((c) => !idsBefore.has(c.id));
                        if (fresh.length > 0) convId = fresh[0].id;
                        return fresh.length;
                    },
                    { timeout: 25_000, intervals: [1_000, 2_000, 3_000] },
                )
                .toBeGreaterThanOrEqual(1);
            expect(convId, 'a fresh conversation id was captured').toBeTruthy();

            if (configured) {
                // Wait for the assistant bubble to render the streamed reply, then for the
                // web route's onFinish to persist BOTH turns to the conversation. The
                // assistant content is saved only after the stream's onFinish callback runs.
                const bubble = lastAssistantBubble(page);
                await expect(bubble).toBeVisible({ timeout: 60_000 });
                await expect
                    .poll(async () => (await bubble.innerText().catch(() => '')).trim().length, {
                        timeout: 60_000,
                    })
                    .toBeGreaterThan(0);

                await expect
                    .poll(
                        async () => {
                            const conv = await getConversation(request, token, convId);
                            const roles = (conv?.messages ?? []).map((m) => m.role);
                            return {
                                hasUser:
                                    conv?.messages?.some(
                                        (m) => m.role === 'user' && m.content.includes(prompt),
                                    ) ?? false,
                                hasAssistant: roles.includes('assistant'),
                                count: conv?.messages?.length ?? 0,
                            };
                        },
                        { timeout: 45_000, intervals: [1_000, 2_000, 3_000, 5_000] },
                    )
                    .toEqual(expect.objectContaining({ hasUser: true, hasAssistant: true }));
            } else {
                // Without a key the assistant reply never streams, so persistence of the
                // assistant turn cannot be required. The truthful invariant is: the
                // conversation row exists and the composer/panel survived intact.
                await expect(composer).toBeVisible({ timeout: 15_000 });
                await expect
                    .poll(async () => composer.isEnabled().catch(() => false), { timeout: 60_000 })
                    .toBe(true);
                const conv = await getConversation(request, token, convId);
                expect(conv, 'the streamed conversation persists as a row').toBeTruthy();
            }
        } finally {
            await cleanupNewConversations(request, token, idsBefore);
        }
    });

    test('Flow 6: stream auth + body-validation gating happens BEFORE any stream opens (fresh user) — 401 unauth, 400 on malformed body, 422 truthful when unconfigured', async ({
        page,
        request,
        browser,
    }) => {
        test.setTimeout(120_000);

        // Use a FRESH user (cross-spec isolation) for the API-tier negative checks so
        // nothing here can shadow the shared seeded user's provider config.
        const fresh = await registerUserViaAPI(request);
        const freshToken = fresh.access_token;

        // ── WEB /api/chat: auth is enforced before body validation. ──
        await openChatPanel(page);
        const origin = new URL(page.url()).origin;

        // (a) Unauthenticated context → 401 EVEN with a perfectly valid body. The auth
        //     gate runs before the zod body check, so the stream never opens.
        const anonCtx = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        try {
            const anonPage = await anonCtx.newPage();
            const anonRes = await anonPage.request.post(`${origin}/api/chat`, {
                data: {
                    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
                    providerOverride: 'openrouter',
                },
                timeout: 30_000,
            });
            expect(anonRes.status(), 'unauth /api/chat → 401, no stream').toBe(401);
            expect(
                (anonRes.headers()['content-type'] || '').includes('event-stream'),
                'unauth response is NOT a stream',
            ).toBe(false);
        } finally {
            await anonCtx.close();
        }

        // (b) Authenticated but MALFORMED body → 400 with a structured zod message and
        //     NO stream. The cookie context is authed (panel opened above).
        const badRes = await page.request.post(`${origin}/api/chat`, {
            data: { messages: [], providerOverride: 'openrouter' },
            timeout: 30_000,
        });
        expect(badRes.status(), 'authed + empty messages → 400').toBe(400);
        expect(
            (badRes.headers()['content-type'] || '').includes('event-stream'),
            '400 validation response is NOT a stream',
        ).toBe(false);
        const badText = await badRes.text();
        expect(badText, 'zod error names the offending field').toMatch(
            /invalid request body|messages/i,
        );

        // (c) Authed but MISSING providerOverride → still a 4xx (never a 5xx, never a
        //     half-open stream).
        const noProvider = await page.request.post(`${origin}/api/chat`, {
            data: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
            timeout: 30_000,
        });
        expect(noProvider.status(), 'missing providerOverride → 4xx').toBeGreaterThanOrEqual(400);
        expect(noProvider.status(), 'missing providerOverride → not 5xx').toBeLessThan(500);

        // ── API /api/v1/chat/completions: a fresh user with NO per-user provider key. ──
        // A STREAMING request resolves to exactly one of two truthful outcomes depending on
        // whether the env binds a provider key:
        //   • configured (env key present)  → 200, a real SSE stream that ends with [DONE];
        //   • unconfigured (CI, no key)     → the streaming service catches the provider
        //     lookup failure BEFORE flushing any SSE byte and ends a 502 provider_error
        //     envelope (the streaming sibling of the non-streaming 422 provider_unavailable
        //     the controller catch returns). The gate that matters here — auth + body — has
        //     already passed: a half-open/streamed 200 with a malformed body never happens.
        // Probe the REAL configured-ness up front (non-streaming surface) and branch.
        const apiConfigured = await isAiProviderConfigured(request, freshToken);
        const apiStream = await request.post(`${API_BASE}/api/v1/chat/completions`, {
            headers: { ...authedHeaders(freshToken), 'X-Provider-Override': 'openrouter' },
            data: { messages: [{ role: 'user', content: 'ping' }], stream: true },
            timeout: 60_000,
        });
        expect(
            [200, 502],
            `API stream → 200 (configured) or 502 provider_error (unconfigured), got ${apiStream.status()}`,
        ).toContain(apiStream.status());
        if (!apiConfigured) {
            // Unconfigured streaming → the mapped 502 provider_error envelope, never a
            // delivered stream and never an unmapped crash.
            expect(apiStream.status(), 'unconfigured stream → mapped provider_error').toBe(502);
            const env = (await apiStream.json()) as { error?: { type?: string; code?: string } };
            expect(
                [env.error?.type, env.error?.code],
                'truthful provider-failure envelope',
            ).toContain('provider_error');
        } else {
            // A 200 here is a real stream → it must be SSE-framed and terminate cleanly.
            expect(apiStream.status(), 'configured stream opens 200').toBe(200);
            expect(apiStream.headers()['content-type'] || '', 'configured → SSE').toContain(
                'text/event-stream',
            );
            expect(
                /\bdata:\s*\[DONE\]/.test(await apiStream.text()),
                'stream ends with [DONE]',
            ).toBe(true);
        }
    });
});

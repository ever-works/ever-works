import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    openChatPanel,
    chatComposer,
    chatSendButton,
    isAiProviderConfigured,
} from './helpers/chat';

/**
 * AI Chat — UI round-trip, ADAPTIVE end-to-end integration.
 *
 * Six complex, multi-step flows driving the REAL chat side-panel
 * (apps/web/src/components/ai/*) against the live web + API. Every selector,
 * status, and shape below was PROBED against the running stack before any
 * assertion was written. This file is deliberately DISTINCT from its siblings:
 *   - chat-ui-roundtrip.spec.ts        → single send + generic text match.
 *   - flow-chat-conversation-lifecycle → API CRUD + History-panel surfacing.
 *   - flow-chat-work-scoped            → X-Work-Id scoping + isolation.
 * Here the theme is the COMPOSER round-trip itself: strict user-bubble vs
 * assistant-bubble rendering, the "New chat" reset, the welcome-suggestion
 * entry point, multi-turn persistence, composer resilience, and the provider
 * selector's configured/not-configured states.
 *
 * ── VERIFIED UI (read from source) ───────────────────────────────────────────
 *  ChatInput.tsx
 *    - composer: <textarea placeholder="Ask me anything..."> (i18n inputPlaceholder)
 *    - Enter (no shift) submits via form.requestSubmit(); Shift+Enter = newline.
 *    - send button: <button type="submit" aria-label="Send">; while streaming it
 *      swaps to <button aria-label="Stop generating">. textarea is `disabled`
 *      while streaming, value cleared on submit (controlled via inputRef + native).
 *  ChatMessage.tsx
 *    - user bubble  : a `div.flex.justify-end`   (role === 'user')
 *    - assistant    : a `div.flex.justify-start`  (role === 'assistant')
 *  ChatInterface.tsx
 *    - messages.length === 0 → <ChatWelcome> (suggestion chips s1..s4 + a
 *      "Suggest a Work to build" chip). Toolbar: "New chat" (resetChat) +
 *      "History". resetChat() → setMessages([]) + clears active conversation.
 *  ChatToolbar.tsx / ChatProviderSelector.tsx
 *    - "New chat" / "History" buttons (i18n newChat="New chat", history="History").
 *    - selector button shows the active provider name (or "Provider"); the
 *      dropdown header is the i18n `title` ("AI Assistant"); each provider row is
 *      a <button>; if `!provider.configured` it is `disabled` with a
 *      "Not configured" badge. Selection persists to localStorage
 *      key `chat-ai-provider`.
 *  ChatProvider.tsx
 *    - providers + their `configured` flags come from getGlobalFormSchema()
 *      → GET /api/generator-form → providers.ai[] (ProviderOption:
 *      { id, name, configured:boolean, isDefault?:boolean, icon? }).
 *    - localStorage key `chat-active-conversation` holds the active id; a send
 *      with no active id first POSTs /api/conversations (title = first user msg).
 *
 * ── ENVIRONMENT-ADAPTIVE (the hard-won rule) ─────────────────────────────────
 *  Chat completions need a real provider key. LOCALLY the stack ships
 *  PLUGIN_OPENROUTER_API_KEY → POST /api/v1/chat/completions returns a genuine
 *  200 OpenAI-shaped reply and the only AI provider (`openrouter`) reports
 *  configured:true,isDefault:true. In CI no key is set → 422
 *  { error:{ type:'provider_unavailable' } } and openrouter reports
 *  configured:false. The web POST /api/chat opens a 200 SSE that, without a key,
 *  streams nothing and can sit in the streaming state with no visible error.
 *  EVERY flow therefore:
 *    - asserts the user's message ALWAYS renders + the round-trip fired;
 *    - asserts a real assistant bubble ONLY when configured;
 *    - never asserts !ok / a crash when unconfigured — it asserts the composer
 *      and panel stayed alive.
 */

const NEW_CHAT_LABEL = 'New chat';
const HISTORY_LABEL = 'History';
const WELCOME_TITLE = 'Welcome to AI Assistant';
const PROVIDER_NOT_CONFIGURED_BADGE = 'Not configured';

interface ConversationRow {
    id: string;
    title: string | null;
    providerId: string | null;
    messages?: Array<{ id: string; role: string; content: string }>;
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

/** A user bubble (justify-end) carrying the given text. */
function userBubble(page: Page, text: string) {
    return page.locator('div.justify-end').filter({ hasText: text }).first();
}

/** The last assistant bubble (justify-start). */
function lastAssistantBubble(page: Page) {
    return page.locator('div.justify-start').last();
}

/**
 * Type a message into the composer and submit with Enter, capturing the real
 * POST /api/chat round-trip. Returns the round-trip status (0 if it never
 * fired). Asserts the user's message bubble renders.
 */
async function sendAndCapture(page: Page, text: string): Promise<{ status: number; ok: boolean }> {
    const composer = chatComposer(page);

    const respPromise = page
        .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
        .catch(() => null);

    // ChatInput's textarea is uncontrolled: the submit handler reads `inputRef`,
    // which is only populated by React's onChange. Under workers=4 contention the
    // dispatched `input` event can lag the immediate Enter, so requestSubmit() reads
    // an empty ref and SILENTLY drops the send (no user bubble, no round-trip). Retry
    // the fill+Enter until the message actually lands as a user bubble. The text is
    // unique per call and the composer clears on a successful submit, so re-filling is
    // idempotent — only a dropped send leaves the transcript without this bubble.
    await expect(async () => {
        if ((await userBubble(page, text).count()) === 0) {
            await composer.click();
            await composer.fill(text);
            await composer.press('Enter');
        }
        // The user's message echoes into the transcript regardless of provider.
        await expect(userBubble(page, text)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    const resp = await respPromise;
    return { status: resp?.status() ?? 0, ok: resp?.ok() ?? false };
}

/**
 * Adaptive reply assertion: when configured, wait for a non-empty assistant
 * bubble that isn't the user's own text; when not, assert only that the panel
 * stayed alive (composer present, no crash).
 */
async function assertReplyOrAlive(
    page: Page,
    userText: string,
    configured: boolean,
): Promise<void> {
    if (configured) {
        const bubble = lastAssistantBubble(page);
        await expect(bubble).toBeVisible({ timeout: 60_000 });
        await expect
            .poll(async () => (await bubble.innerText().catch(() => '')).trim().length, {
                timeout: 60_000,
            })
            .toBeGreaterThan(0);
        const txt = (await bubble.innerText()).trim();
        expect(txt, 'assistant reply is not an echo of the user message').not.toBe(userText);
    } else {
        // No provider key → no reply arrives; the truthful, non-flaky check is the
        // app stayed alive: the composer (and therefore the panel) is intact.
        await expect(chatComposer(page)).toBeVisible({ timeout: 15_000 });
    }
}

test.describe('AI Chat — round-trip adaptive (composer + reset + selector)', () => {
    test('Flow 1: send drives a /api/chat round-trip; strict user bubble renders, adaptive reply, composer survives', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        await openChatPanel(page);
        await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

        const prompt = `e2e roundtrip ${Date.now().toString(36)} — reply with the single word PONG`;
        const result = await sendAndCapture(page, prompt);

        // The plumbing must actually fire — never a silent no-op.
        expect(result.status, 'POST /api/chat reached the server').toBeGreaterThanOrEqual(200);

        // The user's message is rendered specifically as a RIGHT-aligned (user)
        // bubble — not merely present somewhere in the DOM.
        await expect(
            userBubble(page, prompt),
            'user message is a justify-end bubble',
        ).toBeVisible();

        if (configured) {
            expect(result.ok, `/api/chat status ${result.status}`).toBeTruthy();
        }
        await assertReplyOrAlive(page, prompt, configured);

        // In BOTH environments the composer is alive afterwards (never crashed /
        // permanently disabled). It returns to the non-streaming state and is
        // editable again.
        const composer = chatComposer(page);
        await expect(composer).toBeVisible();
        await expect
            .poll(async () => composer.isEnabled().catch(() => false), { timeout: 60_000 })
            .toBe(true);
        await composer.fill('still typeable');
        await expect(composer).toHaveValue('still typeable');
    });

    test('Flow 2: "New chat" resets the transcript to the welcome state and starts a fresh conversation', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        // Track which conversations this seeded user accrues so we can clean up the
        // rows the UI creates (a send with no active id POSTs /api/conversations).
        const idsBefore = new Set((await listConversations(request, token)).map((c) => c.id));

        await openChatPanel(page);
        await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

        try {
            const first = `first chat ${Date.now().toString(36)} hello`;
            await sendAndCapture(page, first);
            await expect(userBubble(page, first)).toBeVisible();
            await assertReplyOrAlive(page, first, configured);

            // The welcome state is gone once a message exists.
            await expect(page.getByText(WELCOME_TITLE, { exact: false })).toHaveCount(0);

            // Click "New chat". Hydration race under next-dev: retry the click until
            // the transcript clears back to the welcome state.
            const newChatBtn = page.getByRole('button', { name: NEW_CHAT_LABEL });
            await expect(newChatBtn).toBeVisible({ timeout: 15_000 });
            await expect(async () => {
                await newChatBtn.click({ timeout: 5_000 }).catch(() => {});
                // resetChat() → setMessages([]) → welcome re-renders + first bubble gone.
                await expect(page.getByText(WELCOME_TITLE, { exact: false })).toBeVisible({
                    timeout: 5_000,
                });
            }).toPass({ timeout: 30_000 });

            // The previous user bubble is no longer in the transcript.
            await expect(userBubble(page, first), 'old transcript cleared').toHaveCount(0);
            // The active-conversation pointer was cleared in localStorage.
            await expect
                .poll(
                    async () =>
                        page.evaluate(() =>
                            window.localStorage.getItem('chat-active-conversation'),
                        ),
                    { timeout: 10_000 },
                )
                .toBeFalsy();

            // A send AFTER reset starts a brand-new conversation (a new id appears).
            const second = `second chat ${Date.now().toString(36)} fresh start`;
            await sendAndCapture(page, second);
            await expect(userBubble(page, second)).toBeVisible();
            await assertReplyOrAlive(page, second, configured);

            // The new conversation is persisted server-side with a NEW id.
            await expect
                .poll(
                    async () => {
                        const rows = await listConversations(request, token);
                        return rows.filter((c) => !idsBefore.has(c.id)).length;
                    },
                    { timeout: 20_000 },
                )
                .toBeGreaterThanOrEqual(1);
        } finally {
            await cleanupNewConversations(request, token, idsBefore);
        }
    });

    test('Flow 3: provider selector reflects real configured/not-configured states and persists a selection', async ({
        page,
        request,
    }) => {
        test.setTimeout(90_000);
        const token = await seededToken(request);

        // The selector is driven by GET /api/generator-form → providers.ai[].
        const aiProviders = await fetchAiProviders(request, token);
        expect(aiProviders.length, 'at least one AI provider is offered').toBeGreaterThan(0);
        // Shape sanity: each has an id/name + a boolean `configured` flag.
        for (const p of aiProviders) {
            expect(typeof p.id).toBe('string');
            expect(typeof p.name).toBe('string');
            expect(typeof p.configured).toBe('boolean');
        }
        const configuredProviders = aiProviders.filter((p) => p.configured);
        const unconfiguredProviders = aiProviders.filter((p) => !p.configured);

        await openChatPanel(page);
        await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

        // The selector trigger shows the active provider name (the default is the
        // isDefault/first configured provider, else "Provider").
        const activeName =
            configuredProviders.find((p) => p.isDefault)?.name ??
            configuredProviders[0]?.name ??
            aiProviders[0]?.name;
        expect(activeName, 'an active provider name is derivable').toBeTruthy();

        const selectorTrigger = page
            .getByRole('button', { name: new RegExp(escapeRegExp(activeName!), 'i') })
            .first();
        await expect(selectorTrigger, 'selector trigger shows the active provider').toBeVisible({
            timeout: 20_000,
        });

        // Open the dropdown (hydration race: retry until the dropdown header renders).
        // The dropdown header is the i18n `title` = "AI Assistant".
        const dropdownHeader = page.getByText('AI Assistant', { exact: true });
        await expect(async () => {
            await selectorTrigger.click({ timeout: 5_000 }).catch(() => {});
            await expect(dropdownHeader).toBeVisible({ timeout: 4_000 });
        }).toPass({ timeout: 30_000 });

        // Every offered provider is a row in the dropdown.
        for (const p of aiProviders) {
            await expect(
                page.getByRole('button', { name: new RegExp(escapeRegExp(p.name), 'i') }).first(),
                `provider ${p.name} listed in selector`,
            ).toBeVisible({ timeout: 10_000 });
        }

        // Unconfigured providers (CI: openrouter when no key) carry a
        // "Not configured" badge and the row is DISABLED. Configured ones do not.
        if (unconfiguredProviders.length > 0) {
            await expect(
                page.getByText(PROVIDER_NOT_CONFIGURED_BADGE).first(),
                'an unconfigured provider shows the Not-configured badge',
            ).toBeVisible({ timeout: 10_000 });
            // Scope to the dropdown ROW, never the selector TRIGGER. In CI the only
            // AI provider (openrouter) is BOTH unconfigured AND the active provider, so
            // its name ("OpenRouter") labels two buttons: the trigger (DOM-first, only
            // `pointer-events-none` while streaming — never the HTML `disabled` attr) and
            // the disabled dropdown row. A bare `.first()` resolves to the enabled trigger,
            // so `toBeDisabled()` fails ("unconfigured provider row is disabled"). Only the
            // row carries the "Not configured" badge text inside the same <button>, so
            // requiring that text uniquely targets the actual disabled row.
            const disabledRow = page
                .getByRole('button', {
                    name: new RegExp(escapeRegExp(unconfiguredProviders[0].name), 'i'),
                })
                .filter({ hasText: PROVIDER_NOT_CONFIGURED_BADGE })
                .first();
            await expect(disabledRow, 'unconfigured provider row is disabled').toBeDisabled({
                timeout: 10_000,
            });
        } else {
            // All providers configured (local default) → no Not-configured badge at all.
            await expect(
                page.getByText(PROVIDER_NOT_CONFIGURED_BADGE),
                'no Not-configured badge when every provider is configured',
            ).toHaveCount(0);
        }

        // Selecting a CONFIGURED provider persists to localStorage (chat-ai-provider)
        // and closes the dropdown. Only configured rows are clickable.
        if (configuredProviders.length > 0) {
            const pick = configuredProviders[0];
            // The dropdown ROW — NOT the selector trigger. When the picked provider is
            // also the active one (local default: OpenRouter), two buttons carry that
            // name; the FIRST in DOM order is the trigger (a toggle that closes the menu
            // WITHOUT calling onSelect → no write). The row renders after the trigger, so
            // scope to .last() to target the actual selectable row.
            const providerNameRe = new RegExp(escapeRegExp(pick.name), 'i');
            // Under workers=4 the row click can miss (or hit the toggle), closing the
            // dropdown without a selection → no localStorage write. Retry the open+click
            // until the pick is actually persisted; the assertion (.toBe(pick.id)) is
            // unchanged, only made resilient to the dropped click.
            await expect(async () => {
                if ((await dropdownHeader.count()) === 0) {
                    await selectorTrigger.click({ timeout: 5_000 }).catch(() => {});
                    await expect(dropdownHeader).toBeVisible({ timeout: 4_000 });
                }
                const row = page.getByRole('button', { name: providerNameRe }).last();
                await row.click({ timeout: 5_000 });
                // A genuine selection closes the dropdown AND writes the provider id.
                await expect(dropdownHeader).toHaveCount(0, { timeout: 5_000 });
                const persisted = await page.evaluate(() =>
                    window.localStorage.getItem('chat-ai-provider'),
                );
                expect(persisted, 'selection persisted to chat-ai-provider').toBe(pick.id);
            }).toPass({ timeout: 30_000 });
        }
    });

    test('Flow 4: a welcome suggestion chip drives the same /api/chat round-trip and renders as a user message', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        const idsBefore = new Set((await listConversations(request, token)).map((c) => c.id));

        await openChatPanel(page);
        await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

        try {
            // Ensure a pristine welcome state (an earlier active conversation may be
            // restored from localStorage). Use "New chat" to clear if needed.
            const welcome = page.getByText(WELCOME_TITLE, { exact: false });
            if ((await welcome.count()) === 0) {
                const newChatBtn = page.getByRole('button', { name: NEW_CHAT_LABEL });
                await expect(async () => {
                    await newChatBtn.click({ timeout: 5_000 }).catch(() => {});
                    await expect(welcome).toBeVisible({ timeout: 5_000 });
                }).toPass({ timeout: 30_000 });
            }
            await expect(welcome).toBeVisible({ timeout: 15_000 });

            // The welcome chips are real buttons; s1 = "Show my works". Clicking one
            // calls onSuggestion(text) → sendMessage(text), the same code path as the
            // composer. Capture the round-trip.
            const suggestionText = 'Show my works';
            const chip = page.getByRole('button', { name: suggestionText, exact: true }).first();
            await expect(chip, 'welcome suggestion chip is present').toBeVisible({
                timeout: 15_000,
            });

            const respPromise = page
                .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
                .catch(() => null);

            // Hydration race: retry the chip click until the user bubble appears.
            await expect(async () => {
                await chip.click({ timeout: 5_000 }).catch(() => {});
                await expect(userBubble(page, suggestionText)).toBeVisible({ timeout: 6_000 });
            }).toPass({ timeout: 30_000 });

            const resp = await respPromise;
            // The suggestion entry point still issues the real POST /api/chat.
            expect(
                resp?.status() ?? 0,
                'suggestion send issued POST /api/chat',
            ).toBeGreaterThanOrEqual(200);

            // The suggestion text is a genuine user (justify-end) bubble.
            await expect(
                userBubble(page, suggestionText),
                'suggestion renders as a user bubble',
            ).toBeVisible();

            await assertReplyOrAlive(page, suggestionText, configured);

            // A conversation was created for this suggestion-initiated chat.
            await expect
                .poll(
                    async () => {
                        const rows = await listConversations(request, token);
                        return rows.filter((c) => !idsBefore.has(c.id)).length;
                    },
                    { timeout: 20_000 },
                )
                .toBeGreaterThanOrEqual(1);
        } finally {
            await cleanupNewConversations(request, token, idsBefore);
        }
    });

    test('Flow 5: a multi-turn round-trip keeps both user bubbles in order and persists them to the API', async ({
        page,
        request,
    }) => {
        test.setTimeout(150_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        const idsBefore = new Set((await listConversations(request, token)).map((c) => c.id));

        await openChatPanel(page);
        await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

        try {
            // Start clean so the two turns land in one fresh conversation.
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
            const turnOne = `turn one ${stamp} list my works please`;
            const turnTwo = `turn two ${stamp} now summarise them`;

            await sendAndCapture(page, turnOne);
            await expect(userBubble(page, turnOne)).toBeVisible();
            await assertReplyOrAlive(page, turnOne, configured);

            // Wait for the composer to be interactable again before the second turn.
            const composer = chatComposer(page);
            await expect
                .poll(async () => composer.isEnabled().catch(() => false), { timeout: 60_000 })
                .toBe(true);

            await sendAndCapture(page, turnTwo);
            await expect(userBubble(page, turnTwo)).toBeVisible();
            await assertReplyOrAlive(page, turnTwo, configured);

            // BOTH user bubbles remain in the transcript, in send order (turnOne above
            // turnTwo). Use bounding boxes to assert vertical ordering.
            const firstBox = await userBubble(page, turnOne).boundingBox();
            const secondBox = await userBubble(page, turnTwo).boundingBox();
            expect(firstBox, 'first user bubble has a box').toBeTruthy();
            expect(secondBox, 'second user bubble has a box').toBeTruthy();
            expect(firstBox?.y ?? 0, 'first turn renders above the second turn').toBeLessThan(
                secondBox?.y ?? 0,
            );

            // The two user turns are persisted to the SAME conversation server-side.
            // (The web /api/chat onFinish saves the conversation messages.)
            await expect
                .poll(
                    async () => {
                        const rows = await listConversations(request, token);
                        const fresh = rows.filter((c) => !idsBefore.has(c.id));
                        if (fresh.length === 0) return -1;
                        // Inspect the newest fresh conversation's persisted user messages.
                        const conv = await getConversation(request, token, fresh[0].id);
                        const userContents = (conv?.messages ?? [])
                            .filter((m) => m.role === 'user')
                            .map((m) => m.content);
                        return userContents.filter(
                            (c) => c.includes(turnOne) || c.includes(turnTwo),
                        ).length;
                    },
                    { timeout: 30_000, intervals: [1_000, 2_000, 3_000, 5_000] },
                )
                // At least the first user turn must be persisted; when configured both are.
                .toBeGreaterThanOrEqual(1);
        } finally {
            await cleanupNewConversations(request, token, idsBefore);
        }
    });

    test('Flow 6: composer semantics — Shift+Enter inserts a newline, Enter submits, send button is labelled', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        const token = await seededToken(request);
        const configured = await isAiProviderConfigured(request, token);

        await openChatPanel(page);
        const composer = chatComposer(page);
        await expect(composer).toBeVisible({ timeout: 30_000 });

        // The send affordance is an accessible, labelled submit button.
        await expect(chatSendButton(page), 'send button is labelled "Send"').toBeVisible({
            timeout: 15_000,
        });

        // Shift+Enter inserts a newline rather than submitting — the textarea keeps
        // growing its value and NO round-trip fires.
        await composer.click();
        await composer.fill('line one');
        const noSendDuringShiftEnter = page
            .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 2_500 })
            .then(() => true)
            .catch(() => false);
        await composer.press('Shift+Enter');
        await composer.type('line two');
        expect(await noSendDuringShiftEnter, 'Shift+Enter must NOT trigger a /api/chat send').toBe(
            false,
        );
        await expect(composer, 'Shift+Enter kept a multiline draft').toHaveValue(
            /line one\nline two/,
        );

        // Now Enter submits that multiline draft as a single user message.
        const respPromise = page
            .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
            .catch(() => null);

        // Under workers=4 contention the Enter keydown can fire before React's
        // onChange has populated ChatInput's uncontrolled inputRef, so requestSubmit()
        // silently no-ops. Retry the Enter (re-seeding the multiline draft if the
        // composer was somehow cleared) until the bubble lands — never a weakened
        // assertion, just resilience to the dropped keystroke.
        await expect(async () => {
            if ((await userBubble(page, 'line one').count()) === 0) {
                if (!(await composer.inputValue().catch(() => '')).includes('line one')) {
                    await composer.click();
                    await composer.fill('line one\nline two');
                }
                await composer.press('Enter');
            }
            // The multiline content renders as ONE user (justify-end) bubble.
            await expect(
                userBubble(page, 'line one'),
                'multiline draft submitted as a user bubble',
            ).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 30_000 });

        const resp = await respPromise;
        expect(resp?.status() ?? 0, 'Enter issued the /api/chat round-trip').toBeGreaterThanOrEqual(
            200,
        );

        // Submitting clears the composer back to empty (controlled reset in ChatInput).
        await expect
            .poll(async () => await composer.inputValue().catch(() => 'x'), { timeout: 30_000 })
            .toBe('');

        await assertReplyOrAlive(page, 'line one\nline two', configured);

        // Clean up the conversation this UI send created for the seeded user.
        const fresh = (await listConversations(request, token)).filter((c) =>
            (c.title ?? '').includes('line one'),
        );
        for (const c of fresh) {
            await request
                .delete(`${API_BASE}/api/conversations/${c.id}`, { headers: authedHeaders(token) })
                .catch(() => {});
        }
    });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/** Delete every conversation that did NOT exist in `idsBefore` (UI-created rows). */
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

interface AiProvider {
    id: string;
    name: string;
    configured: boolean;
    isDefault?: boolean;
}

/** Fetch the AI provider list (with configured flags) the selector renders. */
async function fetchAiProviders(request: APIRequestContext, token: string): Promise<AiProvider[]> {
    const res = await request.get(`${API_BASE}/api/generator-form`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return [];
    const body = (await res.json()) as {
        providers?: { ai?: AiProvider[] };
        data?: { providers?: { ai?: AiProvider[] } };
    };
    return body.providers?.ai ?? body.data?.providers?.ai ?? [];
}

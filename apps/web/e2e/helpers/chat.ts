import { type APIRequestContext, type Page, type Locator, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * AI Chat helpers — UI + API.
 *
 * UI (apps/web/src/components/ai/ChatInput.tsx + layout-client.tsx):
 *   - The chat side-panel is opened server-side by the `chat-panel-open=1`
 *     cookie (read in the dashboard layout → `initialChatOpen`). We set that
 *     cookie + reload as the deterministic open primitive (the collapsed
 *     expand button is an icon-only <button> with no accessible name).
 *   - Composer: a <textarea> with placeholder "Ask me anything…"; Enter submits.
 *   - Send button: <button aria-label="Send"> (submit). Stop button while
 *     streaming: aria-label "Stop generating".
 *   - Messages render as bubbles; assistant bubbles align left (justify-start),
 *     user bubbles align right (justify-end).
 *   - When no AI provider is configured the composer area surfaces
 *     "This provider is not configured. Set it up in Plugins." and a send
 *     attempt errors with "Unable to send message" rather than a reply.
 *
 * API (apps/api/src/ai-conversation/openai-compat.controller.ts):
 *   - POST /api/v1/chat/completions  (Bearer auth, X-Provider-Override header)
 *       → real OpenAI-shaped completion when a provider IS configured;
 *         422 { error:{ type:'provider_unavailable' } } when it isn't.
 *
 * Web route (apps/web/src/app/api/chat/route.ts):
 *   - POST /api/chat (cookie auth, requires `providerOverride`) → SSE stream.
 *
 * Environment note: chat completions need a real provider key. Locally the
 * stack ships PLUGIN_OPENROUTER_API_KEY so a real reply renders; in CI no key
 * is set, so the round-trip terminates in the truthful provider-unavailable
 * state. The helpers below are written to assert the REAL outcome for whatever
 * environment they run in — never to skip the round-trip.
 */

export const CHAT_COMPOSER_PLACEHOLDER = 'Ask me anything...';

export function chatComposer(page: Page): Locator {
    return page.getByPlaceholder(CHAT_COMPOSER_PLACEHOLDER);
}

export function chatSendButton(page: Page): Locator {
    return page.getByRole('button', { name: 'Send', exact: true });
}

/**
 * Ensure the chat side-panel is open and its composer is interactable.
 * Navigates to a dashboard route if the current page isn't one.
 */
export async function openChatPanel(page: Page, dashboardRoute = '/works'): Promise<void> {
    // Open the panel server-side via the chat-panel-open cookie BEFORE the
    // first navigation, so the composer is present on the first authenticated
    // render (no reload dance). The dashboard layout reads this cookie.
    const base = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
    await page
        .context()
        .addCookies([{ name: 'chat-panel-open', value: '1', url: new URL(base).origin }]);

    // Navigate, recovering from a transient cold auth-redirect to /login (the
    // stored session occasionally isn't applied on the very first hit under
    // `next dev` in CI — a fresh navigation with the same storageState authenticates).
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(dashboardRoute, { waitUntil: 'domcontentloaded' });
        if (!/\/login(\?|$)/.test(page.url())) break;
        await page.waitForTimeout(1_500);
    }

    await expect(chatComposer(page)).toBeVisible({ timeout: 45_000 });
}

export interface ChatSendResult {
    /** HTTP status of the POST /api/chat round-trip. */
    status: number;
    ok: boolean;
}

/**
 * Type a message into the composer, submit, and capture the real
 * POST /api/chat network round-trip. Asserts the user's message renders.
 */
export async function sendChatMessage(page: Page, text: string): Promise<ChatSendResult> {
    await openChatPanel(page);
    const composer = chatComposer(page);
    await composer.click();
    await composer.fill(text);

    const respPromise = page
        .waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60_000 })
        .catch(() => null);

    await composer.press('Enter');

    // The user's message echoes into the transcript regardless of provider.
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    const resp = await respPromise;
    return { status: resp?.status() ?? 0, ok: resp?.ok() ?? false };
}

/**
 * Wait for an assistant reply bubble to render non-empty text that is NOT the
 * user's own message. Use only when a provider is known to be configured.
 */
export async function expectAssistantReply(page: Page, userText: string): Promise<string> {
    const assistantBubble = page.locator('div.justify-start').last();
    await expect(assistantBubble).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(async () => (await assistantBubble.innerText().catch(() => '')).trim().length, {
            timeout: 60_000,
        })
        .toBeGreaterThan(0);
    const txt = (await assistantBubble.innerText()).trim();
    expect(txt).not.toBe(userText);
    return txt;
}

/** Is an AI provider configured in this environment (real completions possible)? */
export async function isAiProviderConfigured(
    request: APIRequestContext,
    token: string,
): Promise<boolean> {
    const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
        headers: { ...authedHeaders(token), 'X-Provider-Override': 'openrouter' },
        data: {
            messages: [{ role: 'user', content: 'ping' }],
            stream: false,
        },
    });
    // 422 provider_unavailable → not configured. Anything 2xx → configured.
    return res.ok();
}

export interface ChatCompletion {
    status: number;
    content: string | null;
    model: string | null;
    raw: unknown;
}

/** Call the OpenAI-compatible completion endpoint directly (real round-trip). */
export async function createChatCompletionViaAPI(
    request: APIRequestContext,
    token: string,
    body: {
        messages: Array<{ role: string; content: string }>;
        model?: string;
        provider?: string;
        stream?: boolean;
    },
): Promise<ChatCompletion> {
    const headers: Record<string, string> = authedHeaders(token);
    if (body.provider) headers['X-Provider-Override'] = body.provider;
    const res = await request.post(`${API_BASE}/api/v1/chat/completions`, {
        headers,
        data: { messages: body.messages, model: body.model, stream: body.stream ?? false },
        timeout: 60_000,
    });
    const raw = await res.json().catch(() => null);
    const content =
        (raw as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
            ?.content ?? null;
    const model = (raw as { model?: string })?.model ?? null;
    return { status: res.status(), content, model, raw };
}

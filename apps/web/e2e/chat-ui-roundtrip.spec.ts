import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    openChatPanel,
    sendChatMessage,
    expectAssistantReply,
    isAiProviderConfigured,
    createChatCompletionViaAPI,
    chatComposer,
} from './helpers/chat';

/**
 * AI Chat — real UI round-trip.
 *
 * User ask: "test Chat in UI — send some message, see it gets a response."
 *
 * This drives the actual chat side-panel: open it, type a message, submit, and
 * watch the real POST /api/chat round-trip. The assertion adapts to the
 * environment WITHOUT skipping the round-trip:
 *   - when an AI provider IS configured (locally PLUGIN_OPENROUTER_API_KEY is
 *     set) → assert a real assistant reply bubble renders;
 *   - when it isn't (CI, no key) → assert the round-trip still fired and the UI
 *     surfaces the truthful provider-unavailable state instead of crashing.
 *
 * A companion API-level test proves a genuine completion when a key is present.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token;
}

test.describe('AI Chat — UI round-trip', () => {
    test('sending a message drives a real /api/chat round-trip and renders a reply or truthful state', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const providerConfigured = await isAiProviderConfigured(request, token);

        await openChatPanel(page);
        await expect(chatComposer(page)).toBeVisible({ timeout: 30_000 });

        const prompt = `e2e ping ${Date.now().toString(36)} — reply with the single word PONG`;
        const result = await sendChatMessage(page, prompt);

        // The round-trip must actually fire (never silently no-op).
        expect(result.status, 'POST /api/chat should have been issued').toBeGreaterThan(0);

        if (providerConfigured) {
            // A real provider is wired → assert an actual assistant reply renders.
            expect(result.ok, `/api/chat status ${result.status}`).toBeTruthy();
            const reply = await expectAssistantReply(page, prompt);
            expect(reply.length).toBeGreaterThan(0);
        } else {
            // No provider key (CI default) → the round-trip terminates in the
            // truthful provider-unavailable state, surfaced to the user rather
            // than crashing. Either an error notice renders or the response is
            // a non-2xx; either way the page must still be alive and the
            // composer usable.
            const errorNotice = page.getByText(
                /unable to send message|not configured|provider/i,
            );
            const sawError = await errorNotice
                .first()
                .isVisible({ timeout: 15_000 })
                .catch(() => false);
            expect(
                sawError || !result.ok,
                `expected provider-unavailable signal (status=${result.status})`,
            ).toBeTruthy();
            await expect(chatComposer(page)).toBeVisible();
        }
    });

    test('API: a configured provider returns a real completion; an unconfigured one 422s', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const completion = await createChatCompletionViaAPI(request, token, {
            messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }],
            provider: 'openrouter',
            stream: false,
        });

        if (completion.status === 200) {
            expect(completion.content, 'a configured provider returns message content').toBeTruthy();
            expect(completion.model, 'completion echoes the model used').toBeTruthy();
        } else {
            // Unconfigured environment → the OpenAI-compat controller returns a
            // clean 422 provider_unavailable (never a 5xx).
            expect(completion.status, `unexpected status; body=${JSON.stringify(completion.raw)}`).toBe(
                422,
            );
            const errType = (completion.raw as { error?: { type?: string } })?.error?.type;
            expect(errType).toBe('provider_unavailable');
        }
    });
});

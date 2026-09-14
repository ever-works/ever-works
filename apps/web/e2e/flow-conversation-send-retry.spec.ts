import { test, expect } from '@playwright/test';
import {
    composer,
    createAgentConversationViaAPI,
    createAgentViaAPI,
    listMessagesViaAPI,
    openAgentList,
    openPanelAs,
    registerConversationUser,
} from './helpers/conversations';

/**
 * A message that did not send is shown as failed, with the reason in plain
 * language; it survives a reload; nothing retries it on its own; and Retry —
 * however fast it is tapped — stores it exactly once.
 */
test.describe('Conversation send, failure and retry', () => {
    test('an offline send fails visibly, survives reload, and one burst of Retry sends it once', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerConversationUser(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, `Kai ${Date.now().toString(36)}`);
        const conversationId = await createAgentConversationViaAPI(
            request,
            token,
            agent.id,
            'Hello',
        );
        const body = `Pull last quarter's numbers ${Date.now()}`;

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, agent.name);
            await page.getByTestId('conversation-list-row').first().click();
            // Live delivery is not what this flow tests; keep it on the quiet fallback.
            await page.route('**/api/conversations/stream**', (route) => route.abort());

            await context.setOffline(true);
            await composer(page).fill(body);
            await composer(page).press('Enter');

            const failed = page.getByTestId('conversation-message').filter({ hasText: body });
            await expect(failed.getByTestId('conversation-message-failed')).toContainText(
                'Not sent — you are offline.',
                { timeout: 30_000 },
            );
            await context.setOffline(false);

            // Nothing retries on its own.
            await page.waitForTimeout(3_000);
            expect(
                (await listMessagesViaAPI(request, token, conversationId)).filter(
                    (m) => m.content === body,
                ),
            ).toHaveLength(0);

            // The failed message survives a reload.
            await page.reload({ waitUntil: 'domcontentloaded' });
            const restored = page.getByTestId('conversation-message').filter({ hasText: body });
            await expect(restored.getByTestId('conversation-message-failed')).toBeVisible({
                timeout: 30_000,
            });

            // Two taps in the same instant: one delivery.
            await restored
                .getByRole('button', { name: 'Retry' })
                .evaluate((button: HTMLButtonElement) => {
                    button.click();
                    button.click();
                });

            await expect
                .poll(
                    async () =>
                        (await listMessagesViaAPI(request, token, conversationId)).filter(
                            (m) => m.content === body,
                        ).length,
                )
                .toBe(1);
            await expect(
                page.getByTestId('conversation-message').filter({ hasText: body }),
            ).toHaveCount(1);
            await expect(page.getByTestId('conversation-message-failed')).toHaveCount(0, {
                timeout: 15_000,
            });
            await page.waitForTimeout(2_000);
            expect(
                (await listMessagesViaAPI(request, token, conversationId)).filter(
                    (m) => m.content === body,
                ),
            ).toHaveLength(1);
        } finally {
            await context.close();
        }
    });

    test('a body over 16 KB is held in the composer with its size and the offer to attach it', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerConversationUser(request);
        const agent = await createAgentViaAPI(
            request,
            user.access_token,
            `Devon ${Date.now().toString(36)}`,
        );
        const conversationId = await createAgentConversationViaAPI(
            request,
            user.access_token,
            agent.id,
            'Hi',
        );

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, agent.name);
            await page.getByTestId('conversation-list-row').first().click();
            const long = 'x'.repeat(40 * 1024);
            await composer(page).fill(long);
            await composer(page).press('Enter');

            await expect(page.getByTestId('chat-composer-too-long')).toContainText(
                'Not sent — this message is too long (40 KB of 16 KB).',
            );
            // The text is still in the box, and nothing was stored.
            await expect(composer(page)).toHaveValue(long);
            expect(
                (await listMessagesViaAPI(request, user.access_token, conversationId)).length,
            ).toBe(1);
            await expect(page.getByRole('button', { name: 'Attach as a file' })).toBeVisible();
        } finally {
            await context.close();
        }
    });
});

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
 * Mentions in a Conversation composer: `@` opens the picker, a picked name is
 * highlighted as one unit, an `@word` nobody answers to stays plain, the
 * existing `@kb:` document syntax is left alone, and more than ten mentions
 * are called out before sending. What is highlighted is exactly what lands.
 */
test.describe('Conversation mentions', () => {
    test('picker inserts a highlighted mention; an unmatched word stays plain; the mention lands', async ({
        browser,
        request,
        baseURL,
    }) => {
        const suffix = Date.now().toString(36);
        const user = await registerConversationUser(request);
        const token = user.access_token;
        const nova = await createAgentViaAPI(request, token, `Nova${suffix}`);
        const orion = await createAgentViaAPI(request, token, `Orion${suffix}`);
        const conversationId = await createAgentConversationViaAPI(
            request,
            token,
            nova.id,
            'Kick-off',
        );

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, nova.name);
            await page.getByTestId('conversation-list-row').first().click();

            const box = composer(page);
            await box.click();
            await page.keyboard.type(`Can you get @Orion${suffix.slice(0, 2)}`);
            const picker = page.getByTestId('conversation-mention-picker');
            await expect(picker).toBeVisible();
            await expect(picker.getByRole('option').first()).toContainText(orion.name);
            await page.keyboard.press('Enter');

            await expect(box).toHaveValue(`Can you get @${orion.name} `);
            await expect(picker).toHaveCount(0);
            const marks = page
                .getByTestId('composer-highlight-layer')
                .locator('mark[data-highlight="mention"]');
            await expect(marks).toHaveCount(1);
            await expect(marks.first()).toHaveText(`@${orion.name}`);

            // An @word nobody answers to, and a document reference in its own syntax.
            await page.keyboard.type('to check with @someone-else and @kb:brand/voice');
            await page.keyboard.press('Escape');
            await expect(marks).toHaveCount(1);
            await expect(
                page
                    .getByTestId('composer-highlight-layer')
                    .locator('mark[data-highlight="document"]'),
            ).toHaveText('@kb:brand/voice');

            await page.keyboard.press('Enter');
            await expect
                .poll(async () => {
                    const messages = await listMessagesViaAPI(request, token, conversationId);
                    return messages.find((message) => message.content.includes('@someone-else'))
                        ?.mentions;
                })
                .toEqual([{ type: 'agent', id: orion.id, slug: orion.slug }]);
        } finally {
            await context.close();
        }
    });

    test('an eleventh mention is called out before sending', async ({
        browser,
        request,
        baseURL,
    }) => {
        test.setTimeout(180_000);
        const suffix = Date.now().toString(36);
        const user = await registerConversationUser(request);
        const token = user.access_token;
        const letters = 'abcdefghijk'.split('');
        const agents = [];
        for (const letter of letters) {
            agents.push(await createAgentViaAPI(request, token, `Scout${letter}${suffix}`));
        }
        await createAgentConversationViaAPI(request, token, agents[0].id, 'Roll call');

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, agents[0].name);
            await page.getByTestId('conversation-list-row').first().click();
            await composer(page).click();

            for (const agent of agents) {
                await page.keyboard.type(`@${agent.name}`);
                const option = page
                    .getByTestId('conversation-mention-picker')
                    .getByRole('option')
                    .filter({ hasText: agent.name });
                await expect(option).toBeVisible();
                await page.keyboard.press('Escape');
                await page.keyboard.type('  ');
            }

            await expect(page.getByTestId('chat-composer-mentions-over-limit')).toHaveText(
                'Only 10 mentions land in one message. The rest stay as plain text.',
            );
            await expect(
                page
                    .getByTestId('composer-highlight-layer')
                    .locator('mark[data-highlight="mention"]'),
            ).toHaveCount(10);
        } finally {
            await context.close();
        }
    });
});

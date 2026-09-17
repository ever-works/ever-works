import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import {
    createAgentConversationViaAPI,
    createAgentViaAPI,
    listAgentConversationsViaAPI,
    openAgentList,
    openPanelAs,
    registerConversationUser,
} from './helpers/conversations';

/**
 * Naming a Conversation with an Agent, in the docked chat panel.
 *
 * A Conversation nobody named is listed by its first message — never
 * "Untitled". A person can name it (which stops automatic titling for good),
 * the name survives a reload, and clearing it brings the first message back.
 */
test.describe('Conversation naming', () => {
    test('name, reload, clear — the list falls back to the first message', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerConversationUser(request);
        const token = user.access_token;
        const agent = await createAgentViaAPI(request, token, `Nova ${Date.now().toString(36)}`);
        const firstMessage =
            'Can you check whether the pricing page still claims the old trial length?';
        const conversationId = await createAgentConversationViaAPI(
            request,
            token,
            agent.id,
            firstMessage,
        );
        const name = 'Q4 pricing page';

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, agent.name);

            // Unnamed: the preview alone, never "Untitled".
            const row = page.getByTestId('conversation-list-row').first();
            await expect(row).toContainText(firstMessage.slice(0, 40));
            await expect(page.getByText('Untitled', { exact: false })).toHaveCount(0);

            await row.click();
            await page.getByTestId('conversation-rename').click();
            await page.getByTestId('conversation-name-input').fill(name);
            await page.getByTestId('conversation-name-save').click();
            await expect(page.getByTestId('conversation-name')).toHaveText(name);

            await expect
                .poll(async () => (await listAgentConversationsViaAPI(request, token, agent.id))[0])
                .toMatchObject({ id: conversationId, title: name, titleSource: 'user' });

            // The name survives a reload, and the panel reopens where it was.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId('conversation-name')).toHaveText(name, {
                timeout: 30_000,
            });

            // Named rows show the name above the preview.
            await page.getByTestId('conversation-panel-back').click();
            const namedRow = page.getByTestId('conversation-list-row').first();
            await expect(namedRow).toContainText(name);
            await expect(namedRow).toContainText(firstMessage.slice(0, 40));

            // Clearing the name shows the first message again.
            await namedRow.click();
            await page.getByTestId('conversation-rename').click();
            await page.getByTestId('conversation-name-input').fill('');
            await page.getByTestId('conversation-name-save').click();
            await expect(page.getByTestId('conversation-name')).toHaveCount(0);
            await expect
                .poll(async () => (await listAgentConversationsViaAPI(request, token, agent.id))[0])
                .toMatchObject({ id: conversationId, title: null, titleSource: null });

            await page.getByTestId('conversation-panel-back').click();
            const clearedRow = page.getByTestId('conversation-list-row').first();
            await expect(clearedRow).toContainText(firstMessage.slice(0, 40));
            await expect(clearedRow).not.toContainText(name);
        } finally {
            await context.close();
            await request
                .delete(`${API_BASE}/api/conversations`, { headers: authedHeaders(token) })
                .catch(() => undefined);
        }
    });

    test('a name longer than 200 characters is refused before it is saved', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerConversationUser(request);
        const agent = await createAgentViaAPI(
            request,
            user.access_token,
            `Orion ${Date.now().toString(36)}`,
        );
        await createAgentConversationViaAPI(
            request,
            user.access_token,
            agent.id,
            'Draft the launch note',
        );

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, agent.name);
            await page.getByTestId('conversation-list-row').first().click();
            await page.getByTestId('conversation-rename').click();
            await page.getByTestId('conversation-name-input').fill('x'.repeat(214));
            await expect(
                page.getByText('Names are at most 200 characters. This one is 214.'),
            ).toBeVisible();
            await expect(page.getByTestId('conversation-name-save')).toBeDisabled();
        } finally {
            await context.close();
        }
    });
});

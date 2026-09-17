import { test, expect, type Page } from '@playwright/test';
import {
    composer,
    createAgentViaAPI,
    openAgentList,
    openPanelAs,
    registerConversationUser,
} from './helpers/conversations';

/**
 * The docked panel's navigation: a Conversation with an Agent stays open
 * across dashboard navigation (only its own close control closes it), Back
 * walks Conversation → list → switcher, and the resize handle resets on
 * double-click and moves with the keyboard, with the width surviving a reload.
 */

async function navigateInApp(page: Page, href: string): Promise<void> {
    // Client-side navigation through the sidebar, so the layout is not reloaded.
    const link = page.locator(`nav a[href$="${href}"]`).first();
    await link.click();
    await page.waitForURL(new RegExp(`${href.replace('/', '\\/')}(\\?|$|/)`), { timeout: 30_000 });
}

async function panelWidth(page: Page): Promise<number> {
    return page
        .getByTestId('conversation-panel')
        .evaluate((element) => Math.round(element.getBoundingClientRect().width));
}

test.describe('Conversation panel navigation', () => {
    test('survives five navigations, and Back walks three views', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerConversationUser(request);
        const agent = await createAgentViaAPI(
            request,
            user.access_token,
            `Piper ${Date.now().toString(36)}`,
        );

        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await openAgentList(page, agent.name);
            await expect(page.getByTestId('conversation-list-empty')).toBeVisible();
            await page.getByTestId('conversation-new').click();

            const panel = page.getByTestId('conversation-panel');
            await expect(panel).toHaveAttribute('data-panel-view', 'conversation');
            await composer(page).fill('A draft I have not sent yet');

            for (const href of ['/missions', '/ideas', '/tasks', '/activity', '/works']) {
                await navigateInApp(page, href);
                await expect(panel).toHaveAttribute('data-panel-view', 'conversation');
                await expect(page.getByTestId('conversation-participant-trigger')).toContainText(
                    agent.name,
                );
            }
            // Never unmounted: the unsent draft is still in the box.
            await expect(composer(page)).toHaveValue('A draft I have not sent yet');

            await page.getByTestId('conversation-panel-back').click();
            await expect(panel).toHaveAttribute('data-panel-view', 'list');
            await page.getByTestId('conversation-panel-back').click();
            await expect(panel).toHaveAttribute('data-panel-view', 'switcher');
            await expect(page.getByTestId('conversation-switch-assistant')).toBeVisible();

            // Back to the assistant: its thread renders exactly as before.
            await page.getByTestId('conversation-switch-assistant').click();
            await expect(page.getByPlaceholder('Ask me anything...')).toBeVisible();
        } finally {
            await context.close();
        }
    });

    test('the resize handle resets on double-click, moves with the keyboard, and the width persists', async ({
        browser,
        request,
        baseURL,
    }) => {
        const user = await registerConversationUser(request);
        const { context, page } = await openPanelAs(browser, user, baseURL);
        try {
            await page.setViewportSize({ width: 1600, height: 900 });
            const handle = page.getByTestId('chat-panel-resize-handle');
            await expect(handle).toBeVisible();

            await handle.dblclick();
            await expect.poll(() => panelWidth(page)).toBe(420);

            await handle.focus();
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => panelWidth(page)).toBe(452);

            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect.poll(() => panelWidth(page), { timeout: 30_000 }).toBe(452);

            await page.getByTestId('chat-panel-resize-handle').focus();
            await page.keyboard.press('Home');
            await expect.poll(() => panelWidth(page)).toBe(420);
        } finally {
            await context.close();
        }
    });
});

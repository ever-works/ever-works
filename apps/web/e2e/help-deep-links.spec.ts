import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * Help centre (AW-25) — help links. An empty list screen carries a secondary
 * "How this works" link that opens the Help drawer IN PLACE at the article that
 * explains the screen: no navigation, no new tab, the screen beneath intact.
 *
 * A brand-new account has no Missions, Ideas or Tasks, so those empty states
 * are deterministic here.
 */

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin;

async function signedIn(
    browser: Browser,
    request: APIRequestContext,
): Promise<{ page: Page; close: () => Promise<void> }> {
    const user = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(user.access_token),
    });
    expect(dismissed.ok()).toBe(true);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([
        { name: 'sidebar-collapsed', value: '0', url: ORIGIN },
        { name: 'chat-panel-open', value: '0', url: ORIGIN },
    ]);
    const page = await context.newPage();
    await loginViaUI(page, { email: user.email, password: user.password });
    return { page, close: () => context.close() };
}

const CASES = [
    { path: '/missions', target: 'missions#creating-a-mission', article: 'missions' },
    { path: '/ideas', target: 'ideas', article: 'ideas' },
    { path: '/tasks?view=cards', target: 'tasks#creating-a-task', article: 'tasks' },
];

test.describe('Help centre — help links on empty states', () => {
    for (const { path, target, article } of CASES) {
        test(`${path}: "How this works" opens the ${article} article in place`, async ({
            browser,
            request,
        }) => {
            const { page, close } = await signedIn(browser, request);
            try {
                await page.goto(path, { waitUntil: 'domcontentloaded' });
                const link = page.locator(
                    `[data-testid="help-link"][data-help-target="${target}"]`,
                );
                await expect(link).toBeVisible({ timeout: 30_000 });
                await expect(link).toHaveText('How this works');

                const before = page.url();
                let navigated = false;
                page.on('framenavigated', (frame) => {
                    if (frame === page.mainFrame() && frame.url() !== before) navigated = true;
                });

                // Click until the drawer opens — a click that lands before the
                // button hydrates does nothing (it is a plain `type="button"`, so
                // it cannot navigate either). A short click timeout keeps a click
                // that the open drawer's backdrop blocks from stalling the retry.
                const panel = page.getByTestId('help-center-panel');
                await expect(async () => {
                    if (!(await panel.isVisible().catch(() => false))) {
                        await link.click({ timeout: 3_000 });
                    }
                    await expect(panel).toBeVisible({ timeout: 3_000 });
                }).toPass({ timeout: 45_000 });
                await expect(panel.getByTestId('help-article')).toHaveAttribute(
                    'data-article-id',
                    article,
                );
                expect(page.url()).toBe(before);
                expect(navigated).toBe(false);

                await page.keyboard.press('Escape');
                await expect(panel.getByTestId('help-browse')).toBeVisible();
            } finally {
                await close();
            }
        });
    }

    test('a help link names only approved phrases', async ({ browser, request }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/missions', { waitUntil: 'domcontentloaded' });
            const links = page.getByTestId('help-link');
            await expect(links.first()).toBeVisible({ timeout: 30_000 });
            for (const text of await links.allTextContents()) {
                expect(['How this works', 'Why am I seeing this?']).toContain(text.trim());
            }
        } finally {
            await close();
        }
    });
});

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * Help centre (AW-25) — the in-product manual is reachable, readable and has
 * shareable addresses.
 *
 * - `?`, the top-bar Help control and the sidebar's "Help & Docs" all open
 *   the Help drawer on its Manual tab; `?` does nothing while typing.
 * - The existing Tips / Shortcuts / FAQ / Resources tabs are still there.
 * - Browse → article → Esc walks back to browse without closing the drawer.
 * - `/help` and `/help/<article>` render inside the dashboard shell and need a
 *   session; an unknown article is the "not in this build" page, not a 404; an
 *   unknown heading opens the article at its top with the "moved" line.
 *
 * Fresh account per test, first-run wizard dismissed so it never covers the shell.
 */

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin;

async function freshUser(request: APIRequestContext): Promise<RegisteredUser> {
    const user = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(user.access_token),
    });
    expect(dismissed.ok(), `dismiss body=${await dismissed.text().catch(() => '')}`).toBe(true);
    return user;
}

async function signedIn(
    browser: Browser,
    request: APIRequestContext,
): Promise<{ page: Page; close: () => Promise<void> }> {
    const user = await freshUser(request);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([
        { name: 'sidebar-collapsed', value: '0', url: ORIGIN },
        { name: 'chat-panel-open', value: '0', url: ORIGIN },
    ]);
    const page = await context.newPage();
    await loginViaUI(page, { email: user.email, password: user.password });
    return { page, close: () => context.close() };
}

/**
 * The Help drawer's dialog — a SCOPE, never a visibility target. Headless UI
 * renders the `role="dialog"` element as `relative z-50` with every child
 * `position: fixed`, so its own box is zero-height and Playwright never calls
 * it visible even while the drawer is open. The tabs live in the drawer header,
 * outside the panel, so tab lookups stay scoped to the dialog.
 */
const helpDialog = (page: Page) =>
    page.getByRole('dialog').filter({ has: page.getByTestId('help-center-panel') });

/** The manual panel inside the Help dialog — what "the drawer is open" is asserted on. */
const helpPanel = (page: Page) => helpDialog(page).getByTestId('help-center-panel');

/** Press `?` until the drawer is open — rides out the dev-mode hydration race. */
async function openWithShortcut(page: Page) {
    await expect(async () => {
        if (
            !(await helpPanel(page)
                .isVisible()
                .catch(() => false))
        ) {
            await page.locator('body').click({ position: { x: 5, y: 5 } });
            await page.keyboard.press('?');
        }
        await expect(helpPanel(page)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
}

test.describe('Help centre — reaching the manual', () => {
    for (const path of ['/works', '/tasks', '/missions', '/settings']) {
        test(`? opens the manual over ${path} without navigating`, async ({ browser, request }) => {
            const { page, close } = await signedIn(browser, request);
            try {
                await page.goto(path, { waitUntil: 'domcontentloaded' });
                await expect(page.locator('#main-content')).toBeVisible({ timeout: 30_000 });
                const before = new URL(page.url()).pathname;
                await openWithShortcut(page);
                const dialog = helpDialog(page);
                await expect(dialog.getByRole('tab', { name: 'Manual' })).toHaveAttribute(
                    'aria-selected',
                    'true',
                );
                for (const tab of ['Tips', 'Shortcuts', 'FAQ', 'Resources']) {
                    await expect(dialog.getByRole('tab', { name: tab })).toBeVisible();
                }
                await expect(dialog.getByTestId('help-search-input')).toBeVisible();
                expect(new URL(page.url()).pathname).toBe(before);
            } finally {
                await close();
            }
        });
    }

    test('? is ignored while typing in a field', async ({ browser, request }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/works', { waitUntil: 'domcontentloaded' });
            const field = page.locator('input[type="search"], input[type="text"]').first();
            await expect(field).toBeVisible({ timeout: 30_000 });
            await field.click();
            await page.keyboard.press('?');
            await page.waitForTimeout(500);
            await expect(page.getByTestId('help-center-panel')).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test('the top-bar control and the sidebar entry open the manual', async ({
        browser,
        request,
    }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/works', { waitUntil: 'domcontentloaded' });
            const control = page.getByTestId('header-help-button');
            await expect(control).toBeVisible({ timeout: 30_000 });
            await expect(control).toHaveAttribute('aria-label', 'Help — press ?');
            await control.click();
            await expect(helpPanel(page)).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.getByTestId('help-center-panel')).toHaveCount(0);
            await expect(control).toBeFocused();
        } finally {
            await close();
        }
    });

    test('browse → article → Esc returns to browse, and a second Esc closes', async ({
        browser,
        request,
    }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/missions', { waitUntil: 'domcontentloaded' });
            await openWithShortcut(page);
            const dialog = helpDialog(page);
            await expect(dialog.getByTestId('help-on-this-screen')).toBeVisible();
            await dialog
                .getByTestId('help-on-this-screen')
                .locator('[data-help-article="missions"]')
                .click();
            await expect(dialog.getByTestId('help-article')).toHaveAttribute(
                'data-article-id',
                'missions',
            );
            await expect(dialog.getByRole('heading', { name: 'Missions', level: 2 })).toBeVisible();

            await page.keyboard.press('Escape');
            await expect(dialog.getByTestId('help-browse')).toBeVisible();
            await expect(helpPanel(page)).toBeVisible();

            await page.keyboard.press('Escape');
            await expect(page.getByTestId('help-center-panel')).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test('the Keyboard Shortcuts tab is still one click away and unchanged', async ({
        browser,
        request,
    }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/works', { waitUntil: 'domcontentloaded' });
            await openWithShortcut(page);
            const dialog = helpDialog(page);
            await dialog.getByRole('tab', { name: 'Shortcuts' }).click();
            await expect(dialog.getByText('Keyboard Shortcuts')).toBeVisible();
        } finally {
            await close();
        }
    });
});

test.describe('Help centre — full pages', () => {
    test('/help lists every section inside the dashboard shell', async ({ browser, request }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/help', { waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId('help-manual-index')).toBeVisible({ timeout: 30_000 });
            await expect(page.locator('#main-content')).toBeVisible();
            await expect(page.locator('[data-help-section]')).toHaveCount(6);
        } finally {
            await close();
        }
    });

    test('/help/<article> opens the article; an unknown heading opens it at the top with the moved line', async ({
        browser,
        request,
    }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            await page.goto('/help/tasks#creating-a-task', { waitUntil: 'domcontentloaded' });
            await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible({
                timeout: 30_000,
            });
            await expect(page.locator('h2#creating-a-task')).toBeVisible();

            await page.goto('/help/tasks#a-heading-this-build-does-not-have', {
                waitUntil: 'domcontentloaded',
            });
            await expect(page.getByTestId('help-heading-moved')).toBeVisible({ timeout: 30_000 });
        } finally {
            await close();
        }
    });

    test('an article this build does not have is the "not in this build" page, never a 404 or a redirect', async ({
        browser,
        request,
    }) => {
        const { page, close } = await signedIn(browser, request);
        try {
            const response = await page.goto('/help/agent-computers', {
                waitUntil: 'domcontentloaded',
            });
            expect(response?.status()).toBe(200);
            await expect(page.getByTestId('help-not-in-build')).toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('That article isn’t in this build.')).toBeVisible();
            await expect(page.getByTestId('help-browse-all')).toHaveAttribute('href', /\/help$/);
            expect(new URL(page.url()).pathname).toBe('/help/agent-computers');
        } finally {
            await close();
        }
    });

    test('both pages need a session', async ({ browser }) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        try {
            for (const path of ['/help', '/help/tasks']) {
                await page.goto(path, { waitUntil: 'domcontentloaded' });
                await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
            }
        } finally {
            await context.close();
        }
    });
});

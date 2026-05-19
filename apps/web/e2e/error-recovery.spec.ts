import { test, expect } from '@playwright/test';

/**
 * Error recovery — authenticated pages. Verifies the web app degrades
 * gracefully when API requests fail. We intercept the API calls and
 * force a 5xx, then check the UI doesn't crash to a blank page.
 *
 * Runs under the default `chromium` project (storageState present), so
 * `/en/works` is reachable instead of redirecting to `/login`. The
 * login-form error case lives in error-recovery-unauth.spec.ts so it
 * gets a fresh, unauthenticated context.
 */

test.describe('Error recovery — authenticated pages', () => {
    test('/works page does not white-screen on API 5xx', async ({ page, baseURL }) => {
        // Route the API list endpoint to 503. Browser will retry / show
        // an error UI; we only need it NOT to render an empty <body>.
        await page.route('**/api/works**', (route) => {
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'service unavailable' }),
            });
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/works`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(3_000);
        // Sanity — we MUST still be on /works (storageState authenticated).
        // If we got redirected to /login, the routing in playwright.config.ts
        // is wrong and the test isn't measuring what it claims.
        expect(page.url(), `redirected away from /works: ${page.url()}`).toMatch(/\/works/);
        const bodyText = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        // A working error UI either shows an explicit error message OR
        // at least keeps the nav chrome visible (so user can navigate
        // away). What's NOT acceptable is an empty page.
        expect(
            bodyText.trim().length,
            'works page rendered as blank body on API 5xx',
        ).toBeGreaterThan(20);
    });

    test('/notifications-bell does not crash on API 5xx', async ({ page, baseURL }) => {
        await page.route('**/api/notifications**', (route) => {
            return route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'boom' }),
            });
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2_500);
        // The dashboard chrome must still render even if notifications
        // failed — the bell becomes inert, not the whole shell.
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 10_000 });
    });
});

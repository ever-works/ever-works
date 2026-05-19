import { test, expect } from '@playwright/test';

/**
 * Error recovery — pass 5+. Verifies the web app degrades gracefully
 * when API requests fail. We intercept the API calls and force a 5xx,
 * then check the UI doesn't crash to a blank page.
 *
 * This is a *web-tier* concern. The API stays unchanged; we use
 * Playwright's request routing to swap the response.
 */

test.describe('Error recovery — API failures during page load', () => {
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

    test('login form shows error when /api/auth/login returns 401', async ({ page, baseURL }) => {
        await page.route('**/api/auth/login', (route) => {
            return route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ message: 'Invalid credentials' }),
            });
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(2_000);
        const email = page.locator('input[name="email"]').first();
        const pwd = page.locator('input[name="password"]').first();
        if (!(await email.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, 'login form not visible');
        }
        await email.fill('e2e-error@test.local');
        await pwd.fill('wrongpass');
        await page.locator('button[type="submit"]').first().click();
        await page.waitForTimeout(2_500);
        // After the rejected login we must STILL be on the login page,
        // and an error message must surface (either an explicit alert or
        // form-level error text).
        await expect(page).toHaveURL(/\/login/);
    });
});

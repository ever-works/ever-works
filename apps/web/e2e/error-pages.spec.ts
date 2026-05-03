import { test, expect } from '@playwright/test';

/**
 * Error pages — 404 + auth error.
 *
 * Asserts the localized 404 page renders and the auth/error page handles
 * known error codes without crashing.
 */

test.describe('404 — non-existent routes', () => {
    test('/en/this-route-does-not-exist resolves cleanly (no 5xx)', async ({ page }) => {
        // For an unauth user the middleware may bounce unknown routes to /login;
        // for an authenticated user the locale catch-all renders NotFoundContent.
        // Either is acceptable here — the assertion is "no 500".
        const response = await page.goto('/en/this-route-does-not-exist', {
            waitUntil: 'domcontentloaded',
        });
        expect(response?.status(), 'no 5xx for unknown route').toBeLessThan(500);

        await page.waitForTimeout(800);
        const body = await page.locator('body').innerText();
        // Either the not-found page rendered, OR we got bounced to /login —
        // both prove the route is handled rather than crashing.
        const isNotFound = /not found|page.*found|back home|go back|404/i.test(body);
        const isLogin = /\/login/.test(page.url());
        expect(
            isNotFound || isLogin,
            `expected not-found content or redirect to login — got URL ${page.url()}`,
        ).toBe(true);
    });

    test('/en/works/__nonexistent__/items still renders without 5xx', async ({ page }) => {
        // This route requires auth and runs in the no-auth project — should
        // redirect to /login rather than 5xx.
        await page.goto('/en/works/__nonexistent__/items', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_000);
        await expect(page).toHaveURL(/\/login/);
    });
});

test.describe('Auth error page', () => {
    const errors = [
        'invalid_state',
        'missing_code',
        'callback_failed',
        'provider_conflict',
        'unknown',
    ];

    for (const err of errors) {
        test(`/en/auth/error?error=${err} renders localized error copy`, async ({ page }) => {
            const response = await page.goto(`/en/auth/error?error=${err}`, {
                waitUntil: 'domcontentloaded',
            });
            expect(response?.status(), `auth/error?${err}`).toBeLessThan(500);

            const body = await page.locator('body').innerText();
            // Must mention error / authentication / something useful (in any locale)
            expect(body.length, 'auth error page renders content').toBeGreaterThan(20);
            expect(body, 'auth error page mentions error/authentication').toMatch(
                /error|auth|sign|login|fail/i,
            );
        });
    }
});

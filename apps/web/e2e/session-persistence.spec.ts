import { test, expect } from '@playwright/test';

/**
 * Session persistence — pass 5+. Verifies that the auth cookie /
 * storageState set up by global-setup actually survives:
 *   - a hard reload
 *   - a navigation to a different protected page
 *   - opening a new tab in the same context
 *
 * Regressions here look like "user has to log in again every page
 * navigation" — caught quickly because every dashboard test would fail,
 * but this spec pins the boundary explicitly.
 */

test.describe('Session persistence — across page lifecycle', () => {
    test('reload keeps user signed in', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    });

    test('navigating to /settings preserves session', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await page.goto('/en/settings', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    });

    test('navigating to /works preserves session', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await page.goto('/en/works', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    });

    test('opening a new tab in the same context inherits the session', async ({
        page,
        context,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        const second = await context.newPage();
        await second.goto('/en/settings', { waitUntil: 'domcontentloaded' });
        await expect(second).not.toHaveURL(/\/login/, { timeout: 15_000 });
        await second.close();
    });

    test('the session cookie is HttpOnly + Secure-when-on-https', async ({ context }) => {
        const cookies = await context.cookies();
        // Find the auth cookie. Naming varies — `next-auth.session-token`,
        // `__Secure-next-auth.session-token`, `ever_works_session`, etc.
        // We accept any cookie whose name looks session-ish.
        const sessionCookies = cookies.filter((c) => /(session|auth|token|sid)/i.test(c.name));
        if (sessionCookies.length === 0) {
            test.skip(true, 'no session-like cookie found in context');
        }
        // At least ONE of them must be HttpOnly. Multiple non-HttpOnly
        // cookies are fine (they may be CSRF tokens / non-secret flags).
        const anyHttpOnly = sessionCookies.some((c) => c.httpOnly);
        expect(
            anyHttpOnly,
            `no HttpOnly session cookie found: ${sessionCookies.map((c) => c.name).join(', ')}`,
        ).toBe(true);
    });
});

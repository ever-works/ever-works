import { test, expect } from '@playwright/test';

/**
 * Navigation & route protection E2E tests.
 *
 * These run WITHOUT pre-authenticated state (chromium-no-auth project).
 */

test.describe('Route protection', () => {
    test('should redirect unauthenticated user from dashboard to login', async ({ page }) => {
        await page.goto('/en');

        // Unauthenticated users should be redirected to login
        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });

    test('should redirect unauthenticated user from works to login', async ({ page }) => {
        await page.goto('/en/works');

        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });

    test('should redirect unauthenticated user from settings to login', async ({ page }) => {
        await page.goto('/en/settings');

        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });

    test('should redirect unauthenticated user from new work page to login', async ({ page }) => {
        await page.goto('/en/works/new');

        await page.waitForURL(/\/(login|register|en\/?$)/, { timeout: 10_000 });
    });
});

test.describe('Public pages', () => {
    test('should load login page without redirect', async ({ page }) => {
        await page.goto('/en/login');

        await expect(page).toHaveURL(/\/login/);
        await expect(page.locator('input[name="email"]')).toBeVisible();
    });

    test('should load register page without redirect', async ({ page }) => {
        await page.goto('/en/register');

        await expect(page).toHaveURL(/\/register/);
        await expect(page.locator('input[name="name"]')).toBeVisible();
    });

    test('should load forgot password page without redirect', async ({ page }) => {
        await page.goto('/en/forgot-password');

        await expect(page).toHaveURL(/\/forgot-password/);
        // Should render without 500 error
        await expect(page.locator('body')).not.toContainText('Internal Server Error');
    });
});

test.describe('Locale routing', () => {
    test('root URL stays unprefixed', async ({ page }) => {
        // PR #1052 switched `localePrefix` from `'always'` to `'never'`.
        // `/` no longer redirects to `/en/` — it renders the canonical
        // unprefixed home directly. Assert that the URL does NOT contain
        // a `/<locale>/` segment anywhere; an unprefixed URL like
        // `http://host:port/` (or `/?<query>`) passes.
        //
        // Greptile P1: an earlier draft used a negative lookahead
        // (`/\/(?!en|...)/ `) which is vacuously satisfied by the `/`
        // inside `http://` — every URL passed. The negated `toHaveURL`
        // shape below tests the substring directly, so it can actually
        // fail when a locale prefix sneaks back in.
        await page.goto('/');
        await expect(page).not.toHaveURL(
            /\/(?:en|fr|de|es|pt|nl|it|ja|zh|ar|he|ru|tr|sv|pl|uk|vi|id|hi|fa|bg|fi|no)(?:\/|$|\?|#)/,
        );
    });

    test('legacy /en/<path> URLs redirect to the unprefixed equivalent', async ({ page }) => {
        // Old `/en/login` bookmarks should 307-redirect to `/login` and
        // seed the NEXT_LOCALE cookie (proxy.ts handles this).
        await page.goto('/en/login');
        await expect(page).toHaveURL(/\/login/);
        await expect(page).not.toHaveURL(/\/en\/login/);
    });
});

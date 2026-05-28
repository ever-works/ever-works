import { test, expect } from '@playwright/test';

/**
 * Public-facing surface tests:
 *   - All known dashboard URLs under /works/* exist (redirect to login when unauth)
 *   - <title> uses the "Workshop for AI" tagline / company branding
 *   - Auth/onboarding marketing copy uses Work / Works
 */

test.describe('Works — public routes', () => {
    test.describe.configure({ mode: 'parallel' });

    const protectedRoutes = [
        '/en/works',
        '/en/works/new',
        '/en/works/some-id-that-doesnt-exist',
        '/en/works/some-id/items',
        '/en/works/some-id/generator',
        '/en/works/some-id/settings',
        '/en/works/some-id/plugins',
        '/en/works/some-id/members',
        '/en/works/some-id/deploy',
        '/en/works/some-id/generator/history',
        '/en/works/some-id/generator/comparisons',
        '/en/settings',
        '/en/settings/security',
        '/en/settings/api-keys',
        '/en/plugins',
        '/en/activity',
    ];

    for (const path of protectedRoutes) {
        test(`unauth user is redirected to /login from ${path}`, async ({ page }) => {
            await page.goto(path, { waitUntil: 'networkidle' });
            await expect(page, `${path} should redirect to /login`).toHaveURL(/\/login/);
        });
    }

    // Path pairs: [legacy /en/<path>, canonical /<path>]. PR #1052
    // (`localePrefix: 'never'`) 307-redirects the legacy form to the
    // canonical form. The final URL after navigation is the canonical
    // shape — the test asserts the page loads AND that we ended up on
    // the right page (login → /login, register → /register, etc.),
    // regardless of which input form was used.
    const publicPages: Array<{ entry: string; canonical: RegExp }> = [
        { entry: '/en/login', canonical: /\/login(\?|#|$)/ },
        { entry: '/en/register', canonical: /\/register(\?|#|$)/ },
        { entry: '/en/forgot-password', canonical: /\/forgot-password(\?|#|$)/ },
    ];

    for (const { entry, canonical } of publicPages) {
        test(`public page ${entry} loads and lands on the canonical path`, async ({ page }) => {
            const response = await page.goto(entry, { waitUntil: 'networkidle' });
            expect(response?.status(), `${entry} should not 5xx`).toBeLessThan(500);
            expect(
                page.url(),
                `${entry} should land on the canonical unprefixed path (PR #1052)`,
            ).toMatch(canonical);
        });
    }

    test('login page <title> uses "Workshop for AI" or company branding', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const title = await page.title();
        expect(
            /Workshop for AI|Ever Works|Sign In|Welcome/i.test(title),
            `<title> "${title}" should reflect branding or page name`,
        ).toBe(true);
    });

    test('register page <title> set', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        const title = await page.title();
        expect(title.length, 'register page should have a title').toBeGreaterThan(0);
    });

    test('login feature panel benefits use Work vocabulary', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'feature panel mentions Build Works with AI').toMatch(/build works with ai/i);
        expect(body, 'feature panel mentions AI-Powered').toMatch(/ai[- ]powered/i);
    });

    test('locale routing: explicit /en, /fr, /de prefixes all serve content', async ({ page }) => {
        for (const code of ['en', 'fr', 'de', 'es', 'ru']) {
            const resp = await page.goto(`/${code}/login`, { waitUntil: 'networkidle' });
            expect(resp?.status(), `/${code}/login should not 5xx`).toBeLessThan(500);
            const body = await page.locator('body').innerText();
            expect(body.length, `/${code}/login should have content`).toBeGreaterThan(50);
        }
    });
});

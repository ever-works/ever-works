import { test, expect } from '@playwright/test';

/**
 * Public-facing surface tests for the Directory→Work rename:
 *   - All known dashboard URLs under /works/* exist (redirect to login when unauth)
 *   - The previous /directories/* URLs are gone (404 or bounced)
 *   - <title> uses the new "Workshop for AI" tagline
 *   - Auth/onboarding marketing copy uses Work / Works
 *
 * Old slugs are constructed at runtime (split-and-join) so the bulk
 * rename script doesn't rewrite them in this file.
 */

const OLD_BASE = ['di', 'rec', 'tories'].join(''); // -> "directories" (constructed)

test.describe('Works rename — public routes', () => {
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

    const publicPages = ['/en/login', '/en/register', '/en/forgot-password'];

    for (const path of publicPages) {
        test(`public page ${path} loads (no redirect)`, async ({ page }) => {
            const response = await page.goto(path, { waitUntil: 'networkidle' });
            expect(response?.status(), `${path} should not 5xx`).toBeLessThan(500);
            expect(page.url(), `${path} should not redirect away`).toContain(path);
        });
    }

    test('old /directories URLs are gone (404 or redirect)', async ({ page }) => {
        const oldPaths = [`/en/${OLD_BASE}`, `/en/${OLD_BASE}/new`, `/en/${OLD_BASE}/abc/items`];

        for (const old of oldPaths) {
            const response = await page.goto(old, { waitUntil: 'networkidle' });
            const isNotFound = response?.status() === 404;
            const navigatedAway = !page.url().includes(`/${OLD_BASE}`);
            expect(
                isNotFound || navigatedAway,
                `old ${old} should be gone (status=${response?.status()}, ended at ${page.url()})`,
            ).toBe(true);
        }
    });

    test('login page <title> uses "Workshop for AI" or company branding', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const title = await page.title();
        // Default template is "%s | Ever Works" but the catch-all default is
        // "{companyName} — Workshop for AI". Either is acceptable.
        expect(
            /Workshop for AI|Ever Works|Sign In|Welcome/i.test(title),
            `<title> "${title}" should reflect new branding or page name`,
        ).toBe(true);
    });

    test('register page <title> set', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        const title = await page.title();
        expect(title.length, 'register page should have a title').toBeGreaterThan(0);
    });

    test('login page meta description does not contain old terminology', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const metaDesc = await page.locator('meta[name="description"]').getAttribute('content');
        if (metaDesc) {
            const old = ['di', 'rectory'].join('');
            const oldPlural = ['di', 'rectories'].join('');
            expect(
                metaDesc.toLowerCase(),
                'meta description must not contain old word',
            ).not.toContain(old.toLowerCase());
            expect(
                metaDesc.toLowerCase(),
                'meta description must not contain old plural',
            ).not.toContain(oldPlural.toLowerCase());
        }
    });

    test('login feature panel benefits use new vocabulary', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        // The auth feature panel says "Build Works with AI" + benefit cards.
        expect(body, 'feature panel mentions Build Works with AI').toMatch(/build works with ai/i);
        // benefit titles
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

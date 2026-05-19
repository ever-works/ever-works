import { test, expect } from '@playwright/test';

/**
 * Feature-detect cookies blocked — pass 17. Pass-13
 * `feature-detect-storage` covered localStorage/sessionStorage
 * throwing. This pass covers the orthogonal angle of `document.cookie`
 * being unwritable (or returning empty on read). Some browsers
 * (Brave, Safari with strict ITP) and some user prefs block all
 * cookies — the login page must still render and the form must still
 * be reachable.
 */

test.describe('Cookies blocked — login still functional', () => {
    test('document.cookie writable but reads return "" — login page renders', async ({
        page,
        baseURL,
    }) => {
        await page.addInitScript(() => {
            // Override document.cookie getter to always return '' but
            // accept writes silently. This mimics Brave's "cookies
            // off" mode.
            try {
                Object.defineProperty(document, 'cookie', {
                    get: () => '',
                    set: () => undefined,
                    configurable: true,
                });
            } catch {
                // Some engines refuse to override built-ins.
            }
        });
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res?.status() ?? 0).toBeLessThan(500);
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.length, 'login body empty when cookies blocked').toBeGreaterThan(20);
        // The email field should still render and be fillable.
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 10_000 });
        await email.fill('cookies-blocked@test.local');
        expect(await email.inputValue()).toBe('cookies-blocked@test.local');
    });

    test('document.cookie setter throws — login page still survives', async ({ page, baseURL }) => {
        await page.addInitScript(() => {
            try {
                Object.defineProperty(document, 'cookie', {
                    get: () => '',
                    set: () => {
                        throw new DOMException('SecurityError', 'SecurityError');
                    },
                    configurable: true,
                });
            } catch {
                // ignore
            }
        });
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res?.status() ?? 0).toBeLessThan(500);
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.length, 'login body empty when cookie setter throws').toBeGreaterThan(20);
    });
});

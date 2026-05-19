import { test, expect } from '@playwright/test';

/**
 * Feature-detect storage — pass 13. Safari Private Browsing throws
 * `QuotaExceededError` on localStorage.setItem, and some users disable
 * cookies. The platform should NOT crash to a white screen when these
 * APIs throw — graceful degradation is the contract.
 */

test.describe('Storage disabled — graceful degradation', () => {
    test('login page renders even when localStorage.setItem throws', async ({ page, baseURL }) => {
        await page.addInitScript(() => {
            // Override setItem to throw, mimicking Safari Private mode.
            try {
                const proto = Object.getPrototypeOf(window.localStorage);
                Object.defineProperty(proto, 'setItem', {
                    value: () => {
                        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
                    },
                    configurable: true,
                });
            } catch {
                // Some engines refuse to override built-in prototypes.
                // The init script then no-ops — the test below skips.
            }
        });
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res?.status() ?? 0).toBeLessThan(500);
        // Body must still render — the page can't crash on a setItem
        // throw.
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.length, 'page rendered empty body when localStorage threw').toBeGreaterThan(20);
    });

    test('login form is still interactive even when localStorage.getItem throws', async ({
        page,
        baseURL,
    }) => {
        await page.addInitScript(() => {
            try {
                const proto = Object.getPrototypeOf(window.localStorage);
                Object.defineProperty(proto, 'getItem', {
                    value: () => {
                        throw new DOMException('SecurityError', 'SecurityError');
                    },
                    configurable: true,
                });
            } catch {
                // ignore
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        // Form must still be reachable.
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 10_000 });
        await email.fill('storage-test@test.local');
        const value = await email.inputValue();
        expect(value).toBe('storage-test@test.local');
    });
});

test.describe('Storage disabled — sessionStorage write throws', () => {
    test('login page survives sessionStorage.setItem throwing', async ({ page, baseURL }) => {
        await page.addInitScript(() => {
            try {
                const proto = Object.getPrototypeOf(window.sessionStorage);
                Object.defineProperty(proto, 'setItem', {
                    value: () => {
                        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
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
    });
});

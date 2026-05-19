import { test, expect } from '@playwright/test';

/**
 * Feature-detect fetch throws — pass 18. Some restricted browser
 * extensions (privacy/ad-blockers) replace `fetch` with a stub that
 * rejects all requests with `NetworkError`. The login page must:
 *  - still render
 *  - surface a clear error rather than crashing/freezing
 *  - keep the form interactive
 */

test.describe('Fetch polyfill rejects all — login page survives', () => {
    test('login page renders even when fetch is polyfilled to throw NetworkError', async ({
        page,
        baseURL,
    }) => {
        await page.addInitScript(() => {
            // Override window.fetch to reject. Real-world: a Brave
            // shields rule that blocks all third-party requests, or a
            // strict tracking-protection setting.
            try {
                Object.defineProperty(window, 'fetch', {
                    value: () =>
                        Promise.reject(new TypeError('NetworkError when attempting to fetch')),
                    writable: false,
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
        // Body should be populated — the initial HTML is server-rendered
        // and shouldn't depend on a client fetch to be visible.
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.length, 'login body empty when fetch rejects').toBeGreaterThan(20);
        // The email field should still render.
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible({ timeout: 10_000 });
    });

    test('fetch override that throws synchronously (not async) does not crash render', async ({
        page,
        baseURL,
    }) => {
        await page.addInitScript(() => {
            try {
                Object.defineProperty(window, 'fetch', {
                    value: () => {
                        throw new TypeError('fetch unavailable');
                    },
                    writable: false,
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
        expect(body.length, 'sync-throwing fetch crashed the render').toBeGreaterThan(20);
    });
});

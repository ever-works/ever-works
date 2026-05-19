import { test, expect } from '@playwright/test';

/**
 * Service worker update — pass 12. If a service worker IS registered,
 * a stale version should be replaced cleanly on next navigation. We
 * verify the SW registration is queryable + the update() method
 * doesn't crash.
 */

test.describe('Service worker — update lifecycle', () => {
    test('navigator.serviceWorker.getRegistrations is callable', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const result = await page.evaluate(async () => {
            if (!('serviceWorker' in navigator)) {
                return { supported: false } as const;
            }
            try {
                const regs = await navigator.serviceWorker.getRegistrations();
                return {
                    supported: true,
                    count: regs.length,
                    scopes: regs.map((r) => r.scope),
                } as const;
            } catch (e) {
                return { supported: true, error: String(e) } as const;
            }
        });
        if (!result.supported) test.skip(true, 'serviceWorker API unavailable');
        if ('error' in result) {
            expect(result.error, `getRegistrations threw: ${result.error}`).toBeFalsy();
        }
    });

    test('calling registration.update() (if registered) does not crash', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const result = await page.evaluate(async () => {
            if (!('serviceWorker' in navigator)) return { supported: false } as const;
            const regs = await navigator.serviceWorker.getRegistrations();
            if (regs.length === 0) return { supported: true, count: 0 } as const;
            const errs: string[] = [];
            for (const r of regs) {
                try {
                    await r.update();
                } catch (e) {
                    errs.push(String(e));
                }
            }
            return { supported: true, count: regs.length, errs } as const;
        });
        if (!result.supported) test.skip(true, 'serviceWorker not supported');
        if (result.count === 0) test.skip(true, 'no SW registered');
        expect(result.errs!.length, `update() errors: ${result.errs!.join('; ')}`).toBe(0);
    });

    test('reloading the page does not break with an existing SW', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        await page.reload({ waitUntil: 'networkidle' });
        // Page must still render after reload — would NOT if SW returned
        // a broken cached response.
        const heading = page.locator('h1, h2').first();
        await expect(heading).toBeVisible({ timeout: 15_000 });
    });
});

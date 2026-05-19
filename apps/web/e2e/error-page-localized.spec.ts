import { test, expect } from '@playwright/test';

/**
 * Error page localization — pass 19. /404 and /500-like error pages
 * should respect the URL locale: `/en/non-existent` shows English,
 * `/es/non-existent` shows Spanish (or falls back gracefully without
 * crashing).
 */

test.describe('Error pages — localized per URL locale', () => {
    test('/en/non-existent-page-12345 renders in English (or falls back, never 5xx)', async ({
        page,
        baseURL,
    }) => {
        const res = await page.goto(
            `${baseURL || 'http://localhost:3000'}/en/non-existent-page-${Date.now().toString(36)}`,
            { waitUntil: 'domcontentloaded' },
        );
        // Should be 404. Never 5xx.
        expect(res?.status() ?? 0).toBeLessThan(500);
        // Body must render.
        const body = await page.locator('body').innerText();
        expect(body.length, 'error page body empty').toBeGreaterThan(20);
        // Page should declare lang=en (or omit, defaulting to default).
        const lang = await page.locator('html').getAttribute('lang');
        if (lang) {
            expect(
                lang.toLowerCase().startsWith('en'),
                `/en/<bogus> page has lang="${lang}" — expected en`,
            ).toBe(true);
        }
    });

    test('/es/non-existent-page renders without 5xx', async ({ page, baseURL }) => {
        const res = await page.goto(
            `${baseURL || 'http://localhost:3000'}/es/non-existent-page-${Date.now().toString(36)}`,
            { waitUntil: 'domcontentloaded' },
        );
        expect(res?.status() ?? 0).toBeLessThan(500);
        const body = await page.locator('body').innerText();
        expect(body.length).toBeGreaterThan(20);
        const lang = await page.locator('html').getAttribute('lang');
        // /es/ should declare lang=es, OR fall back to default
        // (typically en). NOT crash.
        if (lang) {
            const acceptable =
                lang.toLowerCase().startsWith('es') || lang.toLowerCase().startsWith('en');
            if (!acceptable) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `/es/<bogus> page has lang="${lang}" — not es and not en`,
                });
            }
        }
    });

    test('/<bogus-locale>/path falls back gracefully without 5xx', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/xx-bogus/non-existent`, {
            waitUntil: 'domcontentloaded',
        });
        expect(
            res?.status() ?? 0,
            `bogus-locale crashed: ${res?.status() ?? 'no-response'}`,
        ).toBeLessThan(500);
    });
});

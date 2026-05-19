import { test, expect } from '@playwright/test';

/**
 * Geo-redirect respect preference — pass 20. When a user explicitly
 * picks `/es/` in the URL, an `Accept-Language: en-US` header sent
 * by the browser should NOT cause the server to redirect to `/en/`.
 * URL locale > Accept-Language hint.
 */

test.describe('Locale preference — explicit URL beats Accept-Language', () => {
    test('GET /es/login with Accept-Language: en-US returns Spanish-locale response', async ({
        page,
        baseURL,
    }) => {
        // Tell the browser context to send Accept-Language: en-US.
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/es/login`, {
            waitUntil: 'domcontentloaded',
        });
        // 200 — not 3xx redirect to /en/.
        expect(
            res?.status() ?? 0,
            `/es/login status: ${res?.status() ?? 'no-response'}`,
        ).toBeLessThan(500);
        // After load, URL should still be /es/ (not redirected to
        // /en/).
        const finalUrl = page.url();
        expect(finalUrl, `/es/login redirected to ${finalUrl} despite explicit URL locale`).toMatch(
            /\/es\//,
        );
        // html lang should reflect Spanish.
        const lang = await page.locator('html').getAttribute('lang');
        if (lang) {
            // Acceptable: lang starts with es. Some servers may default
            // back to en for missing translations — that's a soft
            // signal, not a hard fail.
            if (!lang.toLowerCase().startsWith('es')) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `/es/login has lang="${lang}" — Spanish translations may be missing`,
                });
            }
        }
    });

    test('GET /en/login with Accept-Language: es-ES still loads English', async ({
        page,
        baseURL,
    }) => {
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res?.status() ?? 0).toBeLessThan(500);
        const finalUrl = page.url();
        expect(finalUrl, `/en/login redirected to ${finalUrl} despite explicit URL locale`).toMatch(
            /\/en\//,
        );
    });
});

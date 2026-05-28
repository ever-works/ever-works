import { test, expect } from '@playwright/test';

/**
 * Locale preference — explicit URL beats Accept-Language. When a user
 * explicitly picks `/es/login` in the URL, an `Accept-Language: en-US`
 * header sent by the browser should NOT cause the server to flip them
 * to English. URL-stated locale > Accept-Language hint.
 *
 * PR #1052 switched next-intl from `localePrefix: 'always'` to
 * `'never'`, so `/<locale>/<path>` is now a legacy bookmark shape that
 * 307-redirects to the unprefixed `/<path>` AND seeds the
 * `NEXT_LOCALE` cookie with the explicit locale (only if the visitor
 * doesn't already have a cookie preference). The "URL locale wins"
 * contract survives the cutover via the cookie; the URL bar just no
 * longer carries the locale segment.
 */

test.describe('Locale preference — explicit URL beats Accept-Language', () => {
    test('GET /es/login with Accept-Language: en-US lands on /login with NEXT_LOCALE=es', async ({
        page,
        baseURL,
        context,
    }) => {
        // Clean slate — no pre-existing locale preference cookie.
        await context.clearCookies();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/es/login`, {
            waitUntil: 'domcontentloaded',
        });
        expect(
            res?.status() ?? 0,
            `/es/login status: ${res?.status() ?? 'no-response'}`,
        ).toBeLessThan(500);

        // URL bar drops the locale segment (PR #1052) — the explicit
        // locale survives in the `NEXT_LOCALE` cookie set by the legacy
        // redirect (proxy.ts).
        const finalUrl = page.url();
        expect(
            finalUrl,
            `/es/login should redirect to unprefixed /login (PR #1052) — got ${finalUrl}`,
        ).toMatch(/\/login(\?|$|#)/);

        const cookies = await context.cookies();
        const nextLocale = cookies.find((c) => c.name === 'NEXT_LOCALE');
        expect(
            nextLocale?.value,
            'NEXT_LOCALE cookie should be seeded with the explicit URL locale',
        ).toBe('es');

        // html lang should reflect Spanish — soft signal (server may
        // default back to en for missing translations).
        const lang = await page.locator('html').getAttribute('lang');
        if (lang && !lang.toLowerCase().startsWith('es')) {
            test.info().annotations.push({
                type: 'informational',
                description: `/es/login has lang="${lang}" — Spanish translations may be missing`,
            });
        }
    });

    test('GET /en/login with Accept-Language: es-ES lands on /login with NEXT_LOCALE=en', async ({
        page,
        baseURL,
        context,
    }) => {
        await context.clearCookies();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' });

        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res?.status() ?? 0).toBeLessThan(500);

        const finalUrl = page.url();
        expect(
            finalUrl,
            `/en/login should redirect to unprefixed /login (PR #1052) — got ${finalUrl}`,
        ).toMatch(/\/login(\?|$|#)/);

        const cookies = await context.cookies();
        const nextLocale = cookies.find((c) => c.name === 'NEXT_LOCALE');
        expect(
            nextLocale?.value,
            'NEXT_LOCALE cookie should be seeded with the explicit URL locale',
        ).toBe('en');
    });
});

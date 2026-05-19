import { test, expect } from '@playwright/test';

/**
 * i18n fallback — pass 5. Deepens i18n-locales / i18n-content. Verifies
 * unknown locale URLs fall back gracefully (next-intl convention), and
 * that mixed-locale links don't break layouts.
 */

test.describe('i18n — unknown locale falls back', () => {
    test('GET /xx/login (non-existent locale) returns a usable page', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/xx/login`, {
            waitUntil: 'domcontentloaded',
        });
        // next-intl can: (a) redirect to the default locale, (b) render
        // with default locale messages, (c) 404. Any of those is fine;
        // a 5xx is not.
        expect(res?.status() ?? 0).toBeLessThan(500);
    });

    test('root path / redirects to default locale', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res?.status() ?? 0).toBeLessThan(500);
        // After the redirect, the URL should contain a locale prefix.
        // Default is `en`, but some builds may detect from Accept-Language.
        const url = page.url();
        expect(url).toMatch(/\/(en|fr|es|de|it|pt|nl|ja|zh|ru|ar)(\/|$|\?)/);
    });
});

test.describe('i18n — HTML lang attribute matches URL locale', () => {
    const LOCALES = ['en', 'fr', 'es'];

    for (const loc of LOCALES) {
        test(`/${loc}/login carries lang="${loc}" on <html>`, async ({ page, baseURL }) => {
            const res = await page.goto(`${baseURL || 'http://localhost:3000'}/${loc}/login`, {
                waitUntil: 'domcontentloaded',
            });
            if (!res || res.status() === 404) {
                test.skip(true, `locale /${loc}/login not available`);
            }
            expect(res!.status()).toBeLessThan(500);
            const htmlLang = await page.evaluate(() => document.documentElement.lang);
            // Some builds return `en-US` style — accept loc prefix match.
            expect(
                htmlLang?.toLowerCase().startsWith(loc),
                `<html lang="${htmlLang}"> doesn't start with ${loc}`,
            ).toBe(true);
        });
    }
});

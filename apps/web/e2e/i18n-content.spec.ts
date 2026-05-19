import { test, expect } from '@playwright/test';

/**
 * i18n — deepens i18n-locales.spec.ts by verifying that page content
 * (not just the html lang attribute) actually changes between locales.
 * Probes the login page across a few locales and confirms the title /
 * heading text differs.
 */

const LOCALES_TO_CHECK = ['en', 'es', 'fr', 'de', 'pt', 'it'];

test.describe('i18n — login page content varies across locales', () => {
    test('login titles are distinct across locales', async ({ page, baseURL }) => {
        const titles: Record<string, string> = {};
        for (const locale of LOCALES_TO_CHECK) {
            const url = `${baseURL || 'http://localhost:3000'}/${locale}/login`;
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            titles[locale] = await page.title();
        }
        // At minimum: the English title shouldn't equal another locale's title.
        const en = titles.en;
        expect(en).toBeTruthy();
        const others = LOCALES_TO_CHECK.filter((l) => l !== 'en').map((l) => titles[l]);
        // Some locales may fall back to English if a translation is missing;
        // require that AT LEAST ONE other locale differs from English.
        const anyDifferent = others.some((t) => t && t !== en);
        expect(anyDifferent, `titles: ${JSON.stringify(titles)}`).toBe(true);
    });

    test('login page lang attribute matches locale', async ({ page, baseURL }) => {
        for (const locale of LOCALES_TO_CHECK) {
            const url = `${baseURL || 'http://localhost:3000'}/${locale}/login`;
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            const lang = await page.locator('html').getAttribute('lang');
            // lang may be `en`, `en-US`, `pt-BR`, etc. — should at least START
            // with the requested locale code.
            expect(lang?.toLowerCase()).toMatch(new RegExp(`^${locale}`, 'i'));
        }
    });
});

test.describe('i18n — register page across locales', () => {
    test('register page renders without 5xx on each known locale', async ({ page, baseURL }) => {
        for (const locale of LOCALES_TO_CHECK) {
            const url = `${baseURL || 'http://localhost:3000'}/${locale}/register`;
            const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
            if (res) {
                expect(res.status(), `${locale} register status`).toBeLessThan(500);
            }
        }
    });
});

test.describe('i18n — unknown locale falls back gracefully', () => {
    test('unknown locale code (zz) does not 5xx', async ({ page, baseURL }) => {
        const url = `${baseURL || 'http://localhost:3000'}/zz/login`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (res) {
            // Either redirects to default locale (200/302) or returns 404 —
            // both are acceptable. 5xx is the bug.
            expect(res.status()).toBeLessThan(500);
        }
    });
});

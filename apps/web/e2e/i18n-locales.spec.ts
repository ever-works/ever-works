import { test, expect } from '@playwright/test';

/**
 * i18n / locale routing — every locale serves the public pages without
 * 5xx and uses the right `<html lang>`. Complements `works-i18n.spec.ts`
 * (which covers Work-specific copy) by also covering the auth pages and
 * the locale prefix routing itself.
 */

const LOCALES = [
    'en',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'nl',
    'pl',
    'ru',
    'uk',
    'bg',
    'tr',
    'ar',
    'he',
    'hi',
    'id',
    'vi',
    'th',
    'ja',
    'ko',
    'zh',
];

test.describe('i18n — every locale serves /login + /register cleanly', () => {
    for (const code of LOCALES) {
        test(`/${code}/login responds <500 with <html lang>`, async ({ page }) => {
            const res = await page.goto(`/${code}/login`, { waitUntil: 'domcontentloaded' });
            expect(res?.status(), `${code}/login status: ${res?.status()}`).toBeLessThan(500);

            const lang = await page.locator('html').getAttribute('lang');
            expect(lang, `<html lang> on /${code}/login`).toBeTruthy();
            // `lang` may be a tag like "en-US" — check the prefix.
            expect((lang || '').toLowerCase().startsWith(code)).toBe(true);
        });

        test(`/${code}/register responds <500`, async ({ page }) => {
            const res = await page.goto(`/${code}/register`, { waitUntil: 'domcontentloaded' });
            expect(res?.status(), `${code}/register status: ${res?.status()}`).toBeLessThan(500);
        });
    }
});

test.describe('i18n — body content has substance per locale on /login', () => {
    for (const code of LOCALES) {
        test(`/${code}/login renders >50 chars of body text`, async ({ page }) => {
            await page.goto(`/${code}/login`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1_000);
            const body = await page.locator('body').innerText();
            expect(body.length, `${code}/login body too small`).toBeGreaterThan(50);
        });
    }
});

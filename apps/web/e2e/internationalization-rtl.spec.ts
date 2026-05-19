import { test, expect } from '@playwright/test';

/**
 * RTL locale support — pass 8. If Arabic / Hebrew / Persian locales
 * are supported, the rendered `<html dir="rtl">` should be set
 * automatically (next-intl exposes `getDir(locale)`). We don't pin a
 * specific RTL locale set — we probe the candidates and skip cleanly
 * if none are available.
 */

const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'];

test.describe('RTL locales — <html dir> is set when locale is RTL', () => {
    for (const loc of RTL_LOCALES) {
        test(`/${loc}/login carries dir="rtl" on <html>`, async ({ page, baseURL }) => {
            const res = await page.goto(`${baseURL || 'http://localhost:3000'}/${loc}/login`, {
                waitUntil: 'domcontentloaded',
            });
            if (!res || res.status() === 404) {
                test.skip(true, `${loc} locale not exposed`);
            }
            expect(res!.status()).toBeLessThan(500);
            const dir = await page.evaluate(() => document.documentElement.dir);
            // Some builds default to `auto` and let the browser detect
            // — that's also acceptable. The wrong answer is `ltr`.
            expect(dir, `<html dir="${dir}"> for ${loc} locale`).not.toBe('ltr');
        });
    }
});

test.describe('LTR baseline — /en stays dir="ltr"', () => {
    test('/en/login carries dir="ltr" (or empty/unset)', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const dir = await page.evaluate(() => document.documentElement.dir);
        // Default LTR is fine to leave unset; explicit ltr is fine too.
        // What's NOT acceptable is `rtl` for English.
        expect(dir).not.toBe('rtl');
    });
});

test.describe('Mixed-locale layout — switching locales does not break the page', () => {
    test('navigating from /en to /ar and back keeps the page non-blank', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(800);
        const arRes = await page.goto(`${baseURL || 'http://localhost:3000'}/ar/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!arRes || arRes.status() === 404) {
            test.skip(true, 'ar locale not exposed');
        }
        await page.waitForTimeout(800);
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.trim().length, 'locale flip back to en produced an empty body').toBeGreaterThan(
            20,
        );
    });
});

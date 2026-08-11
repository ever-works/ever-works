import { test, expect } from '@playwright/test';

/**
 * RTL locale support.
 *
 * This spec used to pass while RTL was **entirely unimplemented**. It asserted
 *
 *     expect(dir).not.toBe('ltr')
 *
 * and `document.documentElement.dir` returns the EMPTY STRING when the
 * attribute is absent. `'' !== 'ltr'`, so a page with no `dir` at all satisfied
 * it. Verified live on app-dev.ever.works with the locale switched to Arabic:
 * `lang="ar"` and 530 Arabic characters rendered, but no element in the entire
 * document carried a `dir` attribute and the computed direction from `<main>`
 * up to `<html>` was `ltr` at every level.
 *
 * "Not ltr" is not the contract. The contract is `rtl`, so that is what this
 * asserts now — an unset or `auto` value fails, which is the only way this test
 * can notice the thing it exists to notice.
 *
 * `fa` and `ur` are probed too but are not shipped locales; they skip cleanly
 * on 404 rather than failing.
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
            expect(
                dir,
                `<html dir="${dir}"> for ${loc} locale — an unset or 'auto' dir is what let this ` +
                    `spec pass while RTL was unimplemented, so only 'rtl' counts`,
            ).toBe('rtl');

            // The attribute is only half the contract: it has to actually take
            // effect. A stylesheet forcing `direction: ltr` would leave the
            // attribute set and the layout still backwards.
            const computed = await page.evaluate(() => getComputedStyle(document.body).direction);
            expect(computed, `computed direction on <body> for ${loc}`).toBe('rtl');
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

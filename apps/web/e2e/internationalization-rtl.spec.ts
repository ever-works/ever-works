import { test, expect } from '@playwright/test';

/**
 * RTL locale support.
 *
 * ── Why this spec drives the locale by COOKIE, not by URL ──────────────────
 *
 * `apps/web/src/i18n/routing.ts` sets `localePrefix: 'never'`, and says why:
 * "the locale belongs in user state, not in the URL … next-intl persists the
 * locale in the `NEXT_LOCALE` cookie … internally without ever surfacing the
 * segment to the browser."
 *
 * So `/ar/login` is not an Arabic page — it is a **redirect**. Verified against
 * production:
 *
 *     GET /ar/login  -> 307  https://app.ever.works/login
 *     GET /he/login  -> 307  https://app.ever.works/login
 *     GET /es/login  -> 307  https://app.ever.works/login   ← a SHIPPED locale
 *     GET /fr/login  -> 307  https://app.ever.works/login   ← also shipped
 *
 * Every prefixed path redirects, including locales that certainly exist. This
 * spec used to `page.goto('/ar/login')` and assert `dir === 'rtl'`, so it was
 * asserting against the **English default page** and could never pass for any
 * locale. Its escape hatch only fired on a 404 — but these are 307 → 200, so it
 * did not skip either. That is two of the red shards on stage E2E.
 *
 * Driving the cookie instead reflects how the app actually works, and RTL is
 * genuinely implemented. Verified on production:
 *
 *     Cookie: NEXT_LOCALE=ar  ->  <html lang="ar" dir="rtl">
 *     Cookie: NEXT_LOCALE=he  ->  <html lang="he" dir="rtl">
 *     Cookie: NEXT_LOCALE=en  ->  <html lang="en" dir="ltr">
 *
 * ── Why the assertions are strict ─────────────────────────────────────────
 *
 * This spec once passed while RTL was **entirely unimplemented**. It asserted
 *
 *     expect(dir).not.toBe('ltr')
 *
 * and `document.documentElement.dir` returns the EMPTY STRING when the
 * attribute is absent. `'' !== 'ltr'`, so a page with no `dir` at all satisfied
 * it. "Not ltr" is not the contract; `rtl` is. An unset or `auto` value must
 * fail, which is the only way this test can notice the thing it exists to
 * notice.
 */

/** Shipped RTL locales. `fa`/`ur` are deliberately excluded — see below. */
const RTL_LOCALES = ['ar', 'he'];

/**
 * Set the locale the way the application does, then load the unprefixed path.
 * `baseURL` may be absent in some configs, so derive the cookie domain from the
 * URL actually being used rather than assuming localhost.
 */
async function gotoWithLocale(
    page: import('@playwright/test').Page,
    baseURL: string | undefined,
    locale: string,
    path: string,
) {
    const base = baseURL || 'http://localhost:3000';
    await page.context().addCookies([
        {
            name: 'NEXT_LOCALE',
            value: locale,
            url: base,
        },
    ]);
    return page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
}

test.describe('RTL locales — <html dir> is set when locale is RTL', () => {
    for (const loc of RTL_LOCALES) {
        test(`NEXT_LOCALE=${loc} renders /login with dir="rtl"`, async ({ page, baseURL }) => {
            const res = await gotoWithLocale(page, baseURL, loc, '/login');

            expect(res!.status()).toBeLessThan(500);

            // Control: the locale must actually have been applied. Without this,
            // a silent fallback to English would make the dir assertion below
            // fail for a reason that has nothing to do with RTL support, and the
            // failure message would send the reader hunting in the wrong place.
            const lang = await page.evaluate(() => document.documentElement.lang);
            expect(lang, `locale did not apply — <html lang="${lang}">, expected "${loc}"`).toBe(
                loc,
            );

            const dir = await page.evaluate(() => document.documentElement.dir);
            expect(
                dir,
                `<html dir="${dir}"> for ${loc} — an unset or 'auto' dir is what let this ` +
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

test.describe('LTR baseline — English stays dir="ltr"', () => {
    test('NEXT_LOCALE=en renders /login with dir="ltr" (or unset)', async ({ page, baseURL }) => {
        await gotoWithLocale(page, baseURL, 'en', '/login');
        const dir = await page.evaluate(() => document.documentElement.dir);
        // Default LTR is fine to leave unset; explicit ltr is fine too.
        // What is NOT acceptable is `rtl` for English.
        expect(dir).not.toBe('rtl');
    });
});

test.describe('Mixed-locale layout — switching locales does not break the page', () => {
    test('switching en → ar → en keeps the page non-blank', async ({ page, baseURL }) => {
        await gotoWithLocale(page, baseURL, 'en', '/login');
        await gotoWithLocale(page, baseURL, 'ar', '/login');

        // Control: prove the flip actually happened, so "non-blank after
        // switching back" is a statement about a real locale change.
        expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar');

        await gotoWithLocale(page, baseURL, 'en', '/login');
        const body = await page
            .locator('body')
            .innerText()
            .catch(() => '');
        expect(body.trim().length, 'locale flip back to en produced an empty body').toBeGreaterThan(
            20,
        );
    });
});

/**
 * `fa` and `ur` were probed by the previous version of this spec "and skip
 * cleanly on 404 if not shipped". With `localePrefix: 'never'` there is no 404
 * to skip on — an unsupported locale in `NEXT_LOCALE` silently falls back to
 * the default, so such a test would fail on the `lang` control above rather
 * than skipping. They are therefore left out entirely: a test that cannot
 * distinguish "not shipped" from "broken" is worse than no test.
 *
 * If `fa`/`ur` are ever added to `LOCALES`, add them to `RTL_LOCALES` above and
 * they are covered with no other change.
 */

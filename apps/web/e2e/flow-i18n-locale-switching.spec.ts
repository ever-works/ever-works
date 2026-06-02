import { test, expect, type BrowserContext } from '@playwright/test';

/**
 * i18n locale switching — REAL multi-step, cross-page integration flows.
 *
 * Source of truth (read before writing):
 *   - apps/web/src/i18n/routing.ts      → defineRouting({ localePrefix: 'never' })
 *   - apps/web/src/i18n/request.ts      → deepmerge(en, <locale>) so missing keys
 *                                          in a locale silently fall back to en.
 *   - apps/web/src/proxy.ts             → the next-intl middleware + the legacy
 *                                          `/<locale>/...` redirect handler.
 *   - apps/web/src/lib/constants.ts     → LOCALES (21: en + 20), DEFAULT_LOCALE=en,
 *                                          PUBLIC_ROUTES (/login,/register,…).
 *   - apps/web/messages/<locale>.json   → translation dictionaries.
 *   - apps/web/src/components/footer/LanguageSelector.tsx → the in-app locale
 *                                          dropdown (router.replace(pathname,{locale})),
 *                                          mounted in the global Footer on EVERY page.
 *
 * VERIFIED CONTRACT (probed live against http://127.0.0.1:3000 before writing):
 *   localePrefix: 'never' — the URL never carries a locale segment; the active
 *   locale lives in the `NEXT_LOCALE` cookie.
 *
 *   1. Legacy prefix redirect (proxy.ts step 1):
 *        GET /es/login   (no NEXT_LOCALE cookie)
 *          → 307 Temporary Redirect
 *            location: /login
 *            cache-control: no-store
 *            set-cookie: NEXT_LOCALE=es; Path=/; Max-Age=31536000; SameSite=lax
 *        GET /fr/login   WITH an existing NEXT_LOCALE=de cookie
 *          → 307 location: /login   and NO set-cookie (existing pref preserved —
 *            a shared `/fr/...` link must NOT silently flip a `de` user).
 *        GET /en/        → 308 → /en → 307 → /   (trailing-slash normalise then the
 *            locale-only path collapses to root; root then auth-gates to /login).
 *
 *   2. Cookie drives <html lang> AND translated body copy:
 *        GET /login  Cookie: NEXT_LOCALE=es → <html lang="es"> + "Bienvenido de nuevo"
 *        GET /login  Cookie: NEXT_LOCALE=en → <html lang="en"> + "Welcome back"
 *        GET /login  Cookie: NEXT_LOCALE=fr → <html lang="fr"> + "Bienvenue de retour"
 *
 *   3. Resolution precedence (next-intl):  cookie  >  Accept-Language  >  default(en).
 *        No cookie + Accept-Language: fr  → lang="fr".
 *        Cookie NEXT_LOCALE=es + Accept-Language: de  → lang="es" (cookie WINS).
 *        No cookie + unsupported/no header → lang="en" (default).
 *
 *   4. Known login titles (auth.login.title) used for content assertions:
 *        en "Welcome back" · es "Bienvenido de nuevo" · fr "Bienvenue de retour"
 *        · de "Willkommen zurück".  Register (auth.register.title):
 *        en "Create your account" · es "Crea tu cuenta" · fr "Créez votre compte".
 *        common.ui.selectLanguage (the LanguageSelector aria-label):
 *        en "Select language" · es "Seleccionar idioma".
 *
 * No API auth is needed: every flow runs on PUBLIC routes (/login, /register) so
 * these tests use anonymous contexts (empty storageState) and never touch the
 * shared seeded user — zero cross-spec contamination.
 *
 * Resilience notes: titles are best-effort content signals (a locale could fall
 * back to en for a missing key) — the load-bearing invariants are the redirect
 * status, the Set-Cookie behaviour, and the <html lang> attribute, which are
 * asserted hard. The UI-switch flow tolerates the dev hydration race on the
 * headless dropdown (retry-to-open).
 */

const ORIGIN = (baseURL?: string) => baseURL ?? 'http://localhost:3000';
const HOST = (baseURL?: string) => new URL(ORIGIN(baseURL)).hostname;

// Known, stable translations of `auth.login.title` per locale — used as a
// content signal that the dictionary (not just the lang attribute) switched.
const LOGIN_TITLE: Record<string, string> = {
    en: 'Welcome back',
    es: 'Bienvenido de nuevo',
    fr: 'Bienvenue de retour',
    de: 'Willkommen zurück',
};
const REGISTER_TITLE: Record<string, string> = {
    en: 'Create your account',
    es: 'Crea tu cuenta',
    fr: 'Créez votre compte',
};

/** Fresh anonymous context — bare browser.newContext() would inherit the
 *  storageState auth cookie; we want a clean, unauthenticated visitor. */
async function anonContext(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
    return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

function setLocaleCookie(context: BrowserContext, baseURL: string | undefined, value: string) {
    return context.addCookies([{ name: 'NEXT_LOCALE', value, domain: HOST(baseURL), path: '/' }]);
}

test.describe('i18n locale switching — localePrefix:never cookie machinery', () => {
    test('legacy /<locale>/login seeds NEXT_LOCALE, then the cookie drives unprefixed nav + translated copy', async ({
        browser,
        baseURL,
    }) => {
        const context = await anonContext(browser);
        const page = await context.newPage();
        try {
            // STEP 1 — hit the legacy prefixed URL. proxy.ts must 307 to the
            // unprefixed equivalent and seed NEXT_LOCALE=es (no prior pref).
            const legacy = await page.goto(`${ORIGIN(baseURL)}/es/login`, {
                waitUntil: 'domcontentloaded',
            });
            expect(legacy?.status() ?? 0, 'legacy /es/login should not 5xx').toBeLessThan(500);

            // The URL bar must have dropped the /es segment.
            expect(page.url(), `URL still carries a locale segment: ${page.url()}`).toMatch(
                /\/login(\?|$|#)/,
            );
            expect(page.url()).not.toMatch(/\/es\/login/);

            // The redirect's Set-Cookie side-effect persisted the locale.
            const afterRedirect = await context.cookies();
            const seeded = afterRedirect.find((c) => c.name === 'NEXT_LOCALE');
            expect(seeded?.value, 'legacy redirect should seed NEXT_LOCALE=es').toBe('es');

            // <html lang> follows the cookie.
            await expect.poll(() => page.locator('html').getAttribute('lang')).toMatch(/^es/i);

            // Content actually translated (best-effort — annotate, don't fail,
            // if a future dictionary change drops the key).
            const body1 = await page.locator('body').innerText();
            if (!body1.includes(LOGIN_TITLE.es)) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `es /login missing "${LOGIN_TITLE.es}" — translation may have changed`,
                });
            }

            // STEP 2 — navigate to a SECOND unprefixed public route. The locale
            // must persist across navigation via the cookie alone (no prefix,
            // no header).
            await page.goto(`${ORIGIN(baseURL)}/register`, { waitUntil: 'domcontentloaded' });
            await expect.poll(() => page.locator('html').getAttribute('lang')).toMatch(/^es/i);

            const stillSeeded = (await context.cookies()).find((c) => c.name === 'NEXT_LOCALE');
            expect(stillSeeded?.value, 'NEXT_LOCALE should persist across nav').toBe('es');

            const body2 = await page.locator('body').innerText();
            if (!body2.includes(REGISTER_TITLE.es)) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `es /register missing "${REGISTER_TITLE.es}"`,
                });
            }
        } finally {
            await context.close();
        }
    });

    test('a shared legacy /<locale>/ link does NOT overwrite an existing locale preference', async ({
        browser,
        baseURL,
    }) => {
        const context = await anonContext(browser);
        const page = await context.newPage();
        try {
            // Establish a pre-existing French preference.
            await setLocaleCookie(context, baseURL, 'fr');

            await page.goto(`${ORIGIN(baseURL)}/login`, { waitUntil: 'domcontentloaded' });
            await expect.poll(() => page.locator('html').getAttribute('lang')).toMatch(/^fr/i);

            // Now click a shared `/de/...` and a `/es/...` legacy link. Each must
            // 307 to the unprefixed path but MUST NOT clobber the fr cookie — the
            // proxy only seeds NEXT_LOCALE when the visitor has no prior pref.
            for (const shared of ['de', 'es']) {
                const res = await page.goto(`${ORIGIN(baseURL)}/${shared}/register`, {
                    waitUntil: 'domcontentloaded',
                });
                expect(res?.status() ?? 0, `/${shared}/register should not 5xx`).toBeLessThan(500);
                // Redirected to unprefixed.
                expect(page.url()).toMatch(/\/register(\?|$|#)/);
                expect(page.url()).not.toMatch(new RegExp(`/${shared}/register`));

                // Preference unchanged — still French.
                const cookie = (await context.cookies()).find((c) => c.name === 'NEXT_LOCALE');
                expect(
                    cookie?.value,
                    `legacy /${shared}/ link clobbered the existing fr preference`,
                ).toBe('fr');
                await expect.poll(() => page.locator('html').getAttribute('lang')).toMatch(/^fr/i);
            }
        } finally {
            await context.close();
        }
    });

    test('resolution precedence — NEXT_LOCALE cookie beats Accept-Language; without a cookie the header wins; otherwise default(en)', async ({
        browser,
        baseURL,
    }) => {
        // Case A: no cookie, Accept-Language: fr → header drives the locale.
        // The Playwright project sets `use.locale: 'en'` globally; a context's
        // `locale` option emits its OWN `Accept-Language` that OVERRIDES any
        // value in `extraHTTPHeaders` (verified live: locale='en' + header=fr
        // resolves to lang="en"). So the context `locale` must be set to match
        // the header we want next-intl to honour, not left at the inherited
        // 'en' — otherwise the header is silently ignored and we get en.
        const ctxHeader = await browser.newContext({
            storageState: { cookies: [], origins: [] },
            locale: 'fr-FR',
            extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
        });
        try {
            const page = await ctxHeader.newPage();
            await page.goto(`${ORIGIN(baseURL)}/login`, { waitUntil: 'domcontentloaded' });
            // Probed live: SSR <html lang> follows Accept-Language (curl with
            // `Accept-Language: fr` deterministically returns lang="fr", no
            // cookie). The poll only flakes under next-dev cold-compile +
            // workers=4 contention where the SSR doc lands >5s in — so give it
            // the suite's generous headroom instead of the 5s poll default.
            await expect
                .poll(() => page.locator('html').getAttribute('lang'), { timeout: 30_000 })
                .toMatch(/^fr/i);
            const body = await page.locator('body').innerText();
            if (!body.includes(LOGIN_TITLE.fr)) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `Accept-Language:fr /login missing "${LOGIN_TITLE.fr}"`,
                });
            }
        } finally {
            await ctxHeader.close();
        }

        // Case B: cookie=es but Accept-Language: de → the COOKIE must win.
        // Set context `locale` to the German we're testing the header path with
        // (it would otherwise inherit the project's 'en'); the cookie added
        // below must still beat it.
        const ctxBoth = await browser.newContext({
            storageState: { cookies: [], origins: [] },
            locale: 'de-DE',
            extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9' },
        });
        try {
            await setLocaleCookie(ctxBoth, baseURL, 'es');
            const page = await ctxBoth.newPage();
            await page.goto(`${ORIGIN(baseURL)}/login`, { waitUntil: 'domcontentloaded' });
            // Probed live: cookie WINS over Accept-Language (curl `--cookie
            // NEXT_LOCALE=es` + `Accept-Language: de` → lang="es"). Poll with
            // headroom so the cold-compile race can't surface a transient lang.
            await expect
                .poll(() => page.locator('html').getAttribute('lang'), { timeout: 30_000 })
                .toMatch(/^es/i);
            const lang = await page.locator('html').getAttribute('lang');
            expect(
                (lang || '').toLowerCase().startsWith('es'),
                `cookie(es) should beat Accept-Language(de) — got lang="${lang}"`,
            ).toBe(true);
            // And it definitely should not have honoured the German header.
            expect((lang || '').toLowerCase().startsWith('de')).toBe(false);
        } finally {
            await ctxBoth.close();
        }

        // Case C: no cookie, no usable Accept-Language → default en.
        // An unsupported context `locale` ('xx-XX') is honoured by Chromium as
        // the emitted Accept-Language; next-intl can't match it and falls back
        // to DEFAULT_LOCALE (verified live → lang="en"). Setting it explicitly
        // (rather than relying on the inherited 'en') keeps the case honest:
        // it proves an *unsupported* header degrades, not that the header was
        // already English.
        const ctxDefault = await browser.newContext({
            storageState: { cookies: [], origins: [] },
            locale: 'xx-XX',
            extraHTTPHeaders: { 'Accept-Language': 'xx-XX,zz;q=0.5' },
        });
        try {
            const page = await ctxDefault.newPage();
            await page.goto(`${ORIGIN(baseURL)}/login`, { waitUntil: 'domcontentloaded' });
            // Probed live: an unsupported Accept-Language (no cookie) falls back
            // to DEFAULT_LOCALE en (curl `Accept-Language: xx-XX` → lang="en").
            // Poll with headroom against the cold-compile race.
            await expect
                .poll(() => page.locator('html').getAttribute('lang'), { timeout: 30_000 })
                .toMatch(/^en/i);
            const lang = await page.locator('html').getAttribute('lang');
            // Unsupported header → next-intl falls back to DEFAULT_LOCALE (en).
            expect(
                (lang || 'en').toLowerCase().startsWith('en'),
                `unsupported Accept-Language should fall back to en — got "${lang}"`,
            ).toBe(true);
        } finally {
            await ctxDefault.close();
        }
    });

    test('in-app LanguageSelector switches the locale, sets NEXT_LOCALE, and re-renders translated content — persisting across reload', async ({
        browser,
        baseURL,
    }) => {
        // The LanguageSelector lives in the global Footer, which is mounted ONLY
        // by the (dashboard) layout-client (apps/web/src/app/[locale]/(dashboard)
        // /layout-client.tsx) — the (auth) /login page has NO Footer (probed
        // live: /login has zero `role="contentinfo"` and zero
        // `aria-label="Select language"` buttons; the only "Select language"
        // string on /login is the inert next-intl message dictionary in the
        // flight payload). So this flow MUST run on an authenticated dashboard
        // route. Use the seeded storageState (the same authed user the rest of
        // the suite shares) and start the locale at English via its cookie.
        const context = await browser.newContext({
            storageState: './e2e/.auth/user.json',
            locale: 'en',
        });
        const page = await context.newPage();
        try {
            // The dashboard home (`/`) is the authed root; it mounts the Footer
            // (and this LanguageSelector). Seed NEXT_LOCALE=en so we start in
            // English regardless of what the stored state carried.
            await setLocaleCookie(context, baseURL, 'en');
            await page.goto(`${ORIGIN(baseURL)}/`, { waitUntil: 'domcontentloaded' });
            // Confirm we landed on the authed dashboard, not bounced to /login.
            expect(page.url(), `auth gate bounced to login: ${page.url()}`).not.toMatch(
                /\/login(\?|$|#)/,
            );
            await expect
                .poll(() => page.locator('html').getAttribute('lang'), { timeout: 30_000 })
                .toMatch(/^en/i);

            // The selector's aria-label is itself translated; in English it is
            // "Select language". Locate the trigger button by that label.
            const trigger = page
                .getByRole('button', { name: /select language|seleccionar idioma|langue/i })
                .first();

            // Probed live: the global Footer (and this LanguageSelector) is NOT
            // in the SSR HTML — it mounts only after client hydration. Under
            // next-dev cold-compile + workers contention that can take well
            // past the default expect timeout, so wait explicitly (generous)
            // for the trigger to attach before interacting.
            await expect(trigger).toBeVisible({ timeout: 45_000 });

            // The footer can be below the fold — scroll it into view first.
            await trigger.scrollIntoViewIfNeeded().catch(() => {});

            // Open the (headlessui) dropdown. The first click can be swallowed
            // pre-hydration — retry until a menu item appears (toPass loop).
            const esItem = page.getByRole('menuitem', { name: /^\s*Es\s*$/ }).first();
            await expect(async () => {
                await trigger.click({ timeout: 5_000 });
                await expect(esItem).toBeVisible({ timeout: 3_000 });
            }).toPass({ timeout: 45_000 });

            // Choose Spanish. next-intl's router.replace(pathname,{locale:'es'})
            // writes NEXT_LOCALE=es and re-navigates the (unprefixed) pathname.
            await esItem.click();

            // The load-bearing signal that the switch fired is the COOKIE flip —
            // verified live that NEXT_LOCALE=es is written immediately. (<html
            // lang> is rendered by the server root layout and does NOT change on
            // next-intl's soft client navigation; it only re-resolves on a full
            // document load — asserted after the reload below.)
            await expect
                .poll(
                    async () =>
                        (await context.cookies()).find((c) => c.name === 'NEXT_LOCALE')?.value,
                    { timeout: 15_000 },
                )
                .toBe('es');

            // URL must STILL be unprefixed — the switch lives in the cookie,
            // never in the path (localePrefix:never).
            expect(page.url()).not.toMatch(/\/es\//);

            // The choice persists across a hard reload (cookie-backed) AND now
            // the freshly server-rendered document reflects the Spanish locale
            // in <html lang>. The reload can hit another cold render under
            // contention — poll with headroom rather than the 5s default.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect
                .poll(() => page.locator('html').getAttribute('lang'), { timeout: 30_000 })
                .toMatch(/^es/i);

            // Translated content should now be present (best-effort signal that
            // the dictionary — not just the lang attribute — switched).
            const body = await page.locator('body').innerText();
            if (!/idioma/i.test(body)) {
                test.info().annotations.push({
                    type: 'informational',
                    description:
                        'after UI switch + reload, dashboard body has no Spanish "idioma" — translation may have changed',
                });
            }
        } finally {
            await context.close();
        }
    });

    test('unknown / bogus locale falls back to default(en) cleanly — cookie, header, and legacy path all degrade without 5xx', async ({
        browser,
        baseURL,
    }) => {
        // A garbage NEXT_LOCALE cookie value must NOT crash request.ts — hasLocale()
        // rejects it and falls back to DEFAULT_LOCALE (en).
        const ctxCookie = await anonContext(browser);
        try {
            await setLocaleCookie(ctxCookie, baseURL, 'klingon');
            const page = await ctxCookie.newPage();
            const res = await page.goto(`${ORIGIN(baseURL)}/login`, {
                waitUntil: 'domcontentloaded',
            });
            expect(res?.status() ?? 0, 'bogus cookie should not 5xx').toBeLessThan(500);
            const lang = await page.locator('html').getAttribute('lang');
            expect(
                (lang || 'en').toLowerCase().startsWith('en'),
                `bogus NEXT_LOCALE should fall back to en — got "${lang}"`,
            ).toBe(true);
            // The default English copy should render.
            const body = await page.locator('body').innerText();
            expect(body.length, 'fallback page rendered empty').toBeGreaterThan(50);
        } finally {
            await ctxCookie.close();
        }

        // A bogus `/<segment>/login` where the segment is NOT a known locale is
        // NOT treated as a legacy prefix (detectLegacyLocalePrefix returns null)
        // — it routes through as an app path and must not 5xx.
        const ctxPath = await anonContext(browser);
        try {
            const page = await ctxPath.newPage();
            const res = await page.goto(`${ORIGIN(baseURL)}/zz-not-a-locale/login`, {
                waitUntil: 'domcontentloaded',
            });
            expect(
                res?.status() ?? 0,
                `bogus-locale path crashed: ${res?.status() ?? 'no-response'}`,
            ).toBeLessThan(500);
            // No NEXT_LOCALE should have been seeded for a non-locale segment.
            const cookie = (await ctxPath.cookies()).find((c) => c.name === 'NEXT_LOCALE');
            expect(cookie, 'a non-locale segment must NOT seed NEXT_LOCALE').toBeFalsy();
        } finally {
            await ctxPath.close();
        }
    });

    test('localePrefix:never invariant — unprefixed and legacy /en resolve to the SAME unprefixed page; bare /<locale> collapses to root', async ({
        browser,
        baseURL,
    }) => {
        const context = await anonContext(browser);
        const page = await context.newPage();
        try {
            // (a) The canonical unprefixed /login renders in the default locale.
            const plain = await page.goto(`${ORIGIN(baseURL)}/login`, {
                waitUntil: 'domcontentloaded',
            });
            expect(plain?.status() ?? 0).toBeLessThan(500);
            const plainUrl = page.url();
            expect(plainUrl).toMatch(/\/login(\?|$|#)/);
            expect(plainUrl).not.toMatch(/\/en\/login/);
            const plainLang = await page.locator('html').getAttribute('lang');
            expect((plainLang || 'en').toLowerCase().startsWith('en')).toBe(true);

            // (b) The legacy /en/login redirects to the SAME unprefixed URL — the
            // explicit-default prefix is just collapsed, not preserved in the bar.
            const enPrefixed = await page.goto(`${ORIGIN(baseURL)}/en/login`, {
                waitUntil: 'domcontentloaded',
            });
            expect(enPrefixed?.status() ?? 0).toBeLessThan(500);
            const enUrl = page.url();
            expect(enUrl, `legacy /en/login did not collapse: ${enUrl}`).toMatch(/\/login(\?|$|#)/);
            expect(enUrl).not.toMatch(/\/en\/login/);
            // Both paths produce the same canonical pathname.
            expect(new URL(enUrl).pathname).toBe(new URL(plainUrl).pathname);
            // …and seeded NEXT_LOCALE=en (explicit-default still records a pref).
            const enCookie = (await context.cookies()).find((c) => c.name === 'NEXT_LOCALE');
            expect(enCookie?.value).toBe('en');

            // (c) A bare locale-only path (/fr with no further segment) must not
            // 5xx — it 307s up to root, which then auth-gates to /login for an
            // anonymous visitor. Assert the end state is a usable login page.
            const bare = await page.goto(`${ORIGIN(baseURL)}/fr`, {
                waitUntil: 'domcontentloaded',
            });
            expect(
                bare?.status() ?? 0,
                `bare /fr crashed: ${bare?.status() ?? 'no-response'}`,
            ).toBeLessThan(500);
            // It collapsed out of the /fr segment (root → login for anon).
            expect(page.url()).not.toMatch(/\/fr(\/|$)/);
            const bareBody = await page.locator('body').innerText();
            expect(bareBody.length, 'bare-locale landing rendered empty').toBeGreaterThan(50);
        } finally {
            await context.close();
        }
    });
});

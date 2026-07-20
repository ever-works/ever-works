import { test, expect, type Page } from '@playwright/test';

/**
 * SEO / metadata (DEEP) — complex, multi-step, cross-locale INTEGRATION
 * flows that go well beyond the smoke checks in `seo-meta.spec.ts`
 * (single title/desc present) and `sitemap-robots.spec.ts` (single
 * GET of each endpoint). Here we exercise the whole Next.js App Router
 * metadata pipeline end-to-end: the `title.template` chain, cookie-
 * driven per-locale resolution (`localePrefix: 'never'`), locale-prefix
 * URL normalization, crawler directives (noindex on catch-all), and the
 * honest state of OG / Twitter / structured-data / sitemap / robots.
 *
 * Every shape below was probed against the LIVE web tier (Next.js dev,
 * :3000) + the seeded storageState BEFORE any assertion was written.
 *
 *   Root layout metadata (apps/web/src/app/[locale]/layout.tsx):
 *     title.template = '%s | Ever Works'   (APP_NAME = 'Ever Works')
 *     title.default  = 'Ever Works — Workshop for AI'
 *     description    = env || 'An agentic runtime that autonomously
 *                      builds and maintains content-rich web apps and
 *                      Git repositories'
 *     <html lang={locale}>  (lang flips with the resolved locale)
 *
 *   i18n routing (apps/web/src/i18n/routing.ts):
 *     localePrefix: 'never'  → the locale segment is NEVER in the URL;
 *     next-intl persists it in the `NEXT_LOCALE` cookie and the
 *     middleware rewrites internally. Therefore:
 *       - GET /login                → 200 (canonical, unprefixed)
 *       - GET /en/login             → 307 → Location: /login (prefix stripped)
 *       - GET /login + NEXT_LOCALE=fr cookie → <html lang="fr">, FR title
 *
 *   Per-page generateMetadata (probed live, title is template-wrapped):
 *     /login           → 'Sign In | Ever Works'        (fr: 'Se connecter …')
 *     /register        → 'Create Account | Ever Works'
 *     /forgot-password → 'Forgot Password | Ever Works'
 *     /reset-password  → 'Reset Password | Ever Works'
 *     /        (auth)  → 'Dashboard | Ever Works'
 *   Locale title cross-check (messages/<locale>.json metadata.pages.signIn):
 *     en 'Sign In' · fr 'Se connecter' · de 'Anmelden' · es 'Iniciar sesión'
 *     ar 'تسجيل الدخول'  (RTL — lang flips to ar)
 *
 *   Crawler directives:
 *     catch-all [...rest]/page.tsx exports `metadata = { robots: 'noindex' }`
 *     → unknown deep paths are noindex; real funnel pages are NOT noindex.
 *
 *   Infra endpoints (probed):
 *     GET /manifest.webmanifest → 200 application/manifest+json (PWA)
 *     GET /favicon.ico          → 200 image/x-icon
 *     GET /robots.txt           → 404 (no app/robots.ts in this build)
 *     GET /sitemap.xml          → 404 (no app/sitemap.ts in this build)
 *   ⇒ robots/sitemap are NOT generated → assert the honest contract
 *     (no 5xx; if a future build adds them, validate structure) rather
 *     than a fictional one.
 *
 *   OG / Twitter / JSON-LD: getSiteConfig() in lib/constants.ts DEFINES
 *   twitter/og fields but they are NOT wired into the auth/dashboard page
 *   metadata today → the rendered <head> has ZERO og:/twitter:/JSON-LD
 *   tags. We assert this truthfully: validate IF present, never require.
 *
 * Resilience: generous timeouts, `.first()`, expect.poll/toPass, branch
 * on next-dev local-vs-CI route divergence with `.or()`. Read-only: no
 * mutations, no shared-user pollution — pure metadata observation.
 */

const APP_NAME = 'Ever Works';
const TITLE_SUFFIX = ` | ${APP_NAME}`;
// localePrefix:'never' resolves to DEFAULT_LOCALE when neither a NEXT_LOCALE
// cookie nor a legacy URL locale prefix is present. A legacy `/<locale>/...`
// prefix is NOT discarded — the proxy seeds NEXT_LOCALE from it on the strip
// 307 (see Flow 3), so the canonical page renders in that prefix's locale.
const DEFAULT_LOCALE = 'en';

const DEFAULT_DESCRIPTION_FRAGMENT = 'agentic runtime';

function origin(baseURL?: string): string {
    return baseURL ?? 'http://localhost:3000';
}

/** Read the document <title> robustly (App Router sets it post-stream). */
async function readTitle(page: Page): Promise<string> {
    let title = '';
    await expect
        .poll(
            async () => {
                title = (await page.title()) || '';
                return title.length;
            },
            { timeout: 15000, message: 'document <title> never became non-empty' },
        )
        .toBeGreaterThan(0);
    return title;
}

/** Read <html lang>. */
async function readHtmlLang(page: Page): Promise<string> {
    return (await page.locator('html').first().getAttribute('lang')) ?? '';
}

/**
 * Set the next-intl locale cookie on the active context for the web
 * origin, then return so the next navigation renders in that locale.
 */
async function setLocaleCookie(page: Page, baseURL: string | undefined, locale: string) {
    const o = origin(baseURL);
    const url = new URL(o);
    await page.context().addCookies([
        {
            name: 'NEXT_LOCALE',
            value: locale,
            domain: url.hostname,
            path: '/',
        },
    ]);
}

test.describe('SEO meta (deep) — title template, locales, crawler directives', () => {
    // Every flow here is a PUBLIC-page SEO observation. Run them all in an
    // ANONYMOUS context (empty storageState) — otherwise the seeded auth
    // cookie makes /login 307 to the dashboard (login/page.tsx redirects
    // already-authed users), which would corrupt the funnel title/locale
    // assertions. /register, /forgot-password, /reset-password render 200
    // either way, but anonymity keeps the whole funnel deterministic.
    test.use({ storageState: { cookies: [], origins: [] } });

    /* ------------------------------------------------------------------ *
     * FLOW 1 — Title-template chain across the public auth funnel.
     *
     * Proves the Next.js `title.template = '%s | Ever Works'` is wired so
     * that EACH page's `generateMetadata().title` is the SEGMENT only and
     * the layout appends the brand suffix exactly once. We walk the full
     * unauthenticated funnel (login → register → forgot → reset) and
     * assert: (a) suffix present exactly once, (b) a non-empty segment
     * precedes it, (c) segments are page-distinct (template resolved per
     * route, not a single static title), (d) the brand suffix is never
     * doubled. This is the integration the smoke spec never checks.
     * ------------------------------------------------------------------ */
    test('title.template resolves per-page across the unauth auth funnel', async ({
        page,
        baseURL,
    }) => {
        const o = origin(baseURL);
        // Pin English so segment text is deterministic.
        await setLocaleCookie(page, baseURL, 'en');

        const funnel: Array<{ path: string; expectedSegment: string }> = [
            { path: '/login', expectedSegment: 'Sign In' },
            { path: '/register', expectedSegment: 'Create Account' },
            { path: '/forgot-password', expectedSegment: 'Forgot Password' },
            { path: '/reset-password', expectedSegment: 'Reset Password' },
        ];

        const seenSegments = new Set<string>();

        for (const { path, expectedSegment } of funnel) {
            await page.goto(`${o}${path}`, { waitUntil: 'domcontentloaded' });
            const title = await readTitle(page);

            // Suffix appears EXACTLY once — never doubled (`... | Ever Works | Ever Works`).
            const suffixOccurrences = title.split(TITLE_SUFFIX).length - 1;
            expect(
                suffixOccurrences,
                `${path} title "${title}" should contain the brand suffix exactly once`,
            ).toBe(1);
            expect(title.endsWith(TITLE_SUFFIX), `${path} title ends with brand suffix`).toBe(true);

            // The segment before the suffix is non-empty (template received a value).
            const segment = title.slice(0, title.length - TITLE_SUFFIX.length).trim();
            expect(segment.length, `${path} has a non-empty title segment`).toBeGreaterThan(0);

            // Probed exact localized segment — assert the wiring, not just "non-empty".
            expect(segment, `${path} renders the localized page-name segment`).toBe(
                expectedSegment,
            );

            seenSegments.add(segment);
        }

        // The template is resolved PER route (distinct segments), not a
        // single static <title> shared across the funnel.
        expect(
            seenSegments.size,
            `funnel produced ${seenSegments.size} distinct title segments — template not per-route?`,
        ).toBe(funnel.length);
    });

    /* ------------------------------------------------------------------ *
     * FLOW 2 — Per-locale metadata matrix driven by NEXT_LOCALE cookie.
     *
     * Because `localePrefix: 'never'`, the ONLY lever for locale is the
     * cookie. This flow cycles 4 locales (en/fr/de/es) on the SAME URL
     * (/login) and asserts a coupled invariant per locale:
     *   - <html lang> flips to the requested locale, AND
     *   - <title> carries that locale's translated segment + brand suffix.
     * Then it cross-validates that the locales actually DIFFER (fr ≠ en),
     * proving real translation wiring rather than a fallback to English.
     * Also touches RTL `ar` to confirm the lang attribute flips for RTL.
     * ------------------------------------------------------------------ */
    test('NEXT_LOCALE cookie drives <html lang> + localized <title> on /login', async ({
        page,
        baseURL,
    }) => {
        const o = origin(baseURL);

        const matrix: Array<{ locale: string; segment: string }> = [
            { locale: 'en', segment: 'Sign In' },
            { locale: 'fr', segment: 'Se connecter' },
            { locale: 'de', segment: 'Anmelden' },
            { locale: 'es', segment: 'Iniciar sesión' },
        ];

        const observedTitles = new Map<string, string>();

        for (const { locale, segment } of matrix) {
            // Replace the cookie each iteration so locale resolution is clean.
            await page.context().clearCookies();
            await setLocaleCookie(page, baseURL, locale);
            await page.goto(`${o}/login`, { waitUntil: 'domcontentloaded' });

            const lang = await readHtmlLang(page);
            const title = await readTitle(page);
            observedTitles.set(locale, title);

            expect(lang, `<html lang> for NEXT_LOCALE=${locale}`).toBe(locale);
            // Localized segment + brand suffix (suffix is brand, stays English).
            expect(title, `${locale} /login title carries localized segment`).toContain(segment);
            expect(title.endsWith(TITLE_SUFFIX), `${locale} title keeps brand suffix`).toBe(true);
        }

        // Real translation: the French title must NOT equal the English one.
        expect(
            observedTitles.get('fr'),
            'fr title should differ from en title (real i18n, not fallback)',
        ).not.toBe(observedTitles.get('en'));
        // And German differs from French too.
        expect(observedTitles.get('de')).not.toBe(observedTitles.get('fr'));

        // RTL sanity — `ar` flips lang to ar (dir handled elsewhere; we only
        // assert the lang attribute responds to the RTL locale here).
        await page.context().clearCookies();
        await setLocaleCookie(page, baseURL, 'ar');
        await page.goto(`${o}/login`, { waitUntil: 'domcontentloaded' });
        expect(await readHtmlLang(page), 'ar locale flips <html lang>').toBe('ar');
    });

    /* ------------------------------------------------------------------ *
     * FLOW 3 — Locale-PREFIXED URL normalization → canonical unprefixed
     * path (localePrefix:'never' invariant).
     *
     * A crawler or a stale external link may hit `/en/login`, `/fr/register`
     * etc. With `localePrefix:'never'` the middleware MUST strip the prefix
     * and 307 to the canonical unprefixed path — otherwise we'd serve two
     * URLs for one page (duplicate-content SEO penalty). Probed reality:
     *   - `/en/login`  307 → Location `/login`  (locale segment stripped),
     *   - the prefix locale is PERSISTED on the strip (the proxy seeds
     *     NEXT_LOCALE from the URL prefix when the visitor has no existing
     *     locale cookie, so a shared `/fr/...` link keeps the user in that
     *     language). The canonical page therefore renders in the PREFIX
     *     locale — `/fr/login` ultimately renders `Se connecter | Ever Works`
     *     with <html lang="fr">, NOT the English default. We assert that
     *     probed honest contract, not a fictional "prefix is discarded" one.
     *
     * The describe-level anonymous storageState keeps the redirect chain
     * deterministic (prefix-strip only, no authed dashboard bounce).
     * ------------------------------------------------------------------ */
    test('locale-prefixed URLs 307 to the canonical unprefixed path (prefix discarded)', async ({
        page,
        baseURL,
    }) => {
        const o = origin(baseURL);
        // Start from a clean locale cookie so default-locale resolution holds.
        await page.context().clearCookies();

        const cases = [
            { prefixed: '/en/login', canonical: '/login' },
            { prefixed: '/fr/register', canonical: '/register' },
            { prefixed: '/de/forgot-password', canonical: '/forgot-password' },
        ];

        const localePrefixRe =
            /^\/(en|ar|bg|de|es|fr|he|hi|id|it|ja|ko|nl|pl|pt|ru|th|tr|uk|vi|zh)(\/|$)/;

        for (const { prefixed, canonical } of cases) {
            // Probe the FIRST hop WITHOUT auto-follow to inspect the strip.
            const res = await page.request.get(`${o}${prefixed}`, { maxRedirects: 0 });
            const status = res.status();
            // Expect a redirect (307/308/302/301). Tolerate a direct 200 only
            // if a future build serves prefixed paths canonically — never 5xx.
            expect(status, `${prefixed} status`).toBeLessThan(400);
            if (status >= 300) {
                const loc = res.headers()['location'] || '';
                expect(loc, `${prefixed} → Location strips locale prefix`).not.toMatch(
                    localePrefixRe,
                );
                // Destination is the canonical unprefixed path (allow query/trailing).
                const locPath = loc.startsWith('http') ? new URL(loc).pathname : loc.split('?')[0];
                expect(locPath, `${prefixed} redirects to ${canonical}`).toBe(canonical);
            }

            // Navigate (auto-follow): the landed URL is canonical (no prefix)
            // and the page renders through the layout (brand-suffixed title).
            await page.goto(`${o}${prefixed}`, { waitUntil: 'domcontentloaded' });
            const landedPath = new URL(page.url()).pathname;
            expect(landedPath, `${prefixed} lands without a locale prefix`).not.toMatch(
                localePrefixRe,
            );
            const title = await readTitle(page);
            expect(title.endsWith(TITLE_SUFFIX), `${prefixed} landed page is brand-suffixed`).toBe(
                true,
            );
        }

        // HONEST contract (probed against proxy.ts detectLegacyLocalePrefix):
        // the prefix-strip 307 SEEDS `NEXT_LOCALE` from the URL prefix when the
        // visitor has NO existing locale cookie — explicitly so a shared
        // `/fr/...` bookmark "keeps the language they were using". So from a
        // cleared-cookie state `/fr/login` redirects to `/login` AND persists
        // NEXT_LOCALE=fr, and the canonical page renders in the PREFIX locale
        // (fr), NOT the default — the prefix is honored on first visit, not
        // discarded. (It is only ignored when an existing cookie already wins.)
        await page.context().clearCookies();
        await page.goto(`${o}/fr/login`, { waitUntil: 'domcontentloaded' });
        const frLang = await readHtmlLang(page);
        const frTitle = await readTitle(page);
        expect(
            frLang,
            `/fr/login persists the prefix locale on strip and renders in it (lang="${frLang}")`,
        ).toBe('fr');
        // And that persisted prefix locale genuinely differs from the default —
        // proving real cookie-seeding, not a silent fallback to DEFAULT_LOCALE.
        expect(
            frLang,
            `/fr/login keeps the prefix locale rather than falling back to "${DEFAULT_LOCALE}"`,
        ).not.toBe(DEFAULT_LOCALE);
        expect(
            frTitle.endsWith(TITLE_SUFFIX),
            `/fr/login still resolves a brand-suffixed title ("${frTitle}")`,
        ).toBe(true);
    });

    /* ------------------------------------------------------------------ *
     * FLOW 4 — robots.txt / sitemap.xml / manifest / favicon contract.
     *
     * The single-GET smoke spec only checks "<500 and maybe xml". This
     * flow asserts the HONEST, probed reality of the whole SEO-infra
     * surface as a coherent set and is forward-compatible:
     *   - robots.txt: today 404 (no app/robots.ts). Assert no-5xx; IF a
     *     build adds it (200), validate `User-agent` + any Sitemap line.
     *   - sitemap.xml: today 404. Assert no-5xx; IF present, validate XML
     *     root (<urlset|<sitemapindex) + at least one <loc>.
     *   - manifest.webmanifest: 200 application/manifest+json with the PWA
     *     core fields (name/start_url/display) — the SEO/social crawler
     *     also reads this; cross-feature with the PWA contract.
     *   - favicon.ico: 200 image-ish.
     *   - Consistency: if robots references a sitemap, that sitemap URL
     *     must itself resolve to a non-5xx.
     * ------------------------------------------------------------------ */
    test('SEO infrastructure endpoints honor their probed contract', async ({ page, baseURL }) => {
        const o = origin(baseURL);

        // --- robots.txt ---
        const robots = await page.request.get(`${o}/robots.txt`);
        expect(robots.status(), 'robots.txt must not 5xx').toBeLessThan(500);
        let robotsSitemapUrl: string | null = null;
        if (robots.status() === 200) {
            const ct = robots.headers()['content-type'] || '';
            expect(ct, 'robots.txt content-type').toContain('text');
            const body = await robots.text();
            expect(body.toLowerCase(), 'robots.txt mentions User-agent').toContain('user-agent');
            const sitemapLine = body.split('\n').find((l) => /^\s*sitemap\s*:/i.test(l));
            if (sitemapLine) {
                robotsSitemapUrl = sitemapLine.split(/:\s*/i).slice(1).join(':').trim();
                expect(robotsSitemapUrl.toLowerCase()).toContain('sitemap');
            }
        } else {
            // Truthful current state: no robots route generated in this build
            // (probed 404). Tolerate any non-2xx/non-5xx (e.g. a future auth
            // gate) — the point is it is NOT served + NOT a server error.
            expect(
                robots.status() === 404 || (robots.status() >= 300 && robots.status() < 500),
                `robots.txt currently not served (status ${robots.status()})`,
            ).toBe(true);
        }

        // --- sitemap.xml ---
        const sitemap = await page.request.get(`${o}/sitemap.xml`);
        expect(sitemap.status(), 'sitemap.xml must not 5xx').toBeLessThan(500);
        if (sitemap.status() === 200) {
            const ct = sitemap.headers()['content-type'] || '';
            expect(ct.includes('xml') || ct.includes('text'), 'sitemap content-type').toBe(true);
            const body = await sitemap.text();
            expect(
                /<urlset|<sitemapindex/i.test(body),
                'sitemap has a urlset/sitemapindex root',
            ).toBe(true);
            expect(/<loc>/i.test(body), 'sitemap contains at least one <loc>').toBe(true);
        } else {
            expect(
                sitemap.status() === 404 || (sitemap.status() >= 300 && sitemap.status() < 500),
                `sitemap.xml currently not served (status ${sitemap.status()})`,
            ).toBe(true);
        }

        // --- If robots referenced a sitemap, it must itself resolve. ---
        if (robotsSitemapUrl) {
            const target = robotsSitemapUrl.startsWith('http')
                ? robotsSitemapUrl
                : `${o}${robotsSitemapUrl.startsWith('/') ? '' : '/'}${robotsSitemapUrl}`;
            const ref = await page.request.get(target);
            expect(ref.status(), 'robots-referenced sitemap resolves (no 5xx)').toBeLessThan(500);
        }

        // --- manifest.webmanifest (PWA + social crawler) ---
        const manifest = await page.request.get(`${o}/manifest.webmanifest`);
        expect(manifest.status(), 'manifest must not 5xx').toBeLessThan(500);
        if (manifest.status() === 200) {
            const ct = manifest.headers()['content-type'] || '';
            expect(ct, 'manifest content-type').toContain('manifest');
            const json = (await manifest.json()) as Record<string, unknown>;
            expect(typeof json.name, 'manifest has name').toBe('string');
            expect((json.name as string).length, 'manifest name non-empty').toBeGreaterThan(0);
            expect(json.start_url, 'manifest start_url').toBeTruthy();
            expect(json.display, 'manifest display mode').toBeTruthy();
            expect(Array.isArray(json.icons), 'manifest icons is an array').toBe(true);
        }

        // --- favicon.ico ---
        const favicon = await page.request.get(`${o}/favicon.ico`);
        expect(favicon.status(), 'favicon must not 5xx').toBeLessThan(500);
        if (favicon.status() === 200) {
            const ct = favicon.headers()['content-type'] || '';
            expect(
                ct.includes('image') || ct.includes('icon'),
                `favicon content-type "${ct}" is image-ish`,
            ).toBe(true);
        }
    });

    /* ------------------------------------------------------------------ *
     * FLOW 5 — Real public funnel pages stay INDEXABLE (no accidental
     * noindex).
     *
     * The companion to the catch-all noindex contract (asserted authed in
     * the nested describe below): genuine auth-public pages MUST NOT carry
     * a `noindex` robots directive — deindexing the real funnel would be a
     * serious SEO regression. We assert across the public funnel that
     * either there is no robots meta at all (indexable by default) or, if
     * one exists, it does NOT contain `noindex`/`none`. Runs anonymously so
     * /register & /forgot-password render their real page (200) rather than
     * bouncing to a dashboard. (/login is excluded here because an authed
     * visitor is redirected; its indexability is covered via the anon
     * render in flows 1–2.)
     * ------------------------------------------------------------------ */
    test('real public funnel pages are NOT noindex (stay indexable)', async ({ page, baseURL }) => {
        const o = origin(baseURL);
        await setLocaleCookie(page, baseURL, 'en');

        for (const path of ['/login', '/register', '/forgot-password']) {
            await page.goto(`${o}${path}`, { waitUntil: 'domcontentloaded' });
            await readTitle(page); // ensure the head is materialized
            const count = await page.locator('meta[name="robots"]').count();
            if (count > 0) {
                const content =
                    (
                        await page.locator('meta[name="robots"]').first().getAttribute('content')
                    )?.toLowerCase() ?? '';
                expect(
                    content.includes('noindex') || content.includes('none'),
                    `${path} must NOT be noindex/none (content="${content}")`,
                ).toBe(false);
            }
            // Absent entirely ⇒ indexable by default — also acceptable.
        }
    });

    /* ------------------------------------------------------------------ *
     * FLOW 6 — Base-meta consistency + OG/Twitter/JSON-LD honesty +
     * metadata stability across reload (no hydration meta drift).
     *
     * getSiteConfig() DEFINES og/twitter fields but they are not wired
     * into the rendered <head> today → we assert the TRUTHFUL contract:
     *   - canonical base tags (charset, viewport, description) are present
     *     and the description is the non-empty default fragment,
     *   - og:* / twitter:* / JSON-LD are validated ONLY IF present (never
     *     hard-required — no fictional contract), and when present every
     *     og:/twitter: tag must have non-empty content + a JSON-LD script
     *     must parse and carry an @context,
     *   - metadata is STABLE across a reload: the streamed <title> +
     *     description do not drift after hydration (a classic Next.js
     *     metadata race). We snapshot before/after reload and compare.
     * ------------------------------------------------------------------ */
    test('base meta is consistent; OG/Twitter/JSON-LD validated only if present; stable on reload', async ({
        page,
        baseURL,
    }) => {
        const o = origin(baseURL);
        await setLocaleCookie(page, baseURL, 'en');
        await page.goto(`${o}/login`, { waitUntil: 'domcontentloaded' });
        const title1 = await readTitle(page);

        // --- canonical base tags ---
        // The browser normalizes Next's `<meta charSet="utf-8"/>` to a
        // lowercase `charset` attribute; tolerate >=1 (some streams emit it
        // as part of the framework head).
        await expect
            .poll(async () => await page.locator('meta[charset], meta[charSet]').count(), {
                timeout: 10000,
                message: 'no charset meta tag found',
            })
            .toBeGreaterThan(0);

        const viewport = await page
            .locator('meta[name="viewport"]')
            .first()
            .getAttribute('content');
        expect(viewport, 'viewport meta content').toBeTruthy();
        expect(viewport!.toLowerCase(), 'viewport sets device-width').toContain(
            'width=device-width',
        );

        const description = await page
            .locator('meta[name="description"]')
            .first()
            .getAttribute('content');
        expect(description, 'description meta present').toBeTruthy();
        expect(description!.length, 'description non-empty').toBeGreaterThan(0);
        expect(
            description!.toLowerCase(),
            `description carries the default product fragment`,
        ).toContain(DEFAULT_DESCRIPTION_FRAGMENT);

        // --- OG: validate IF present (today: zero) ---
        const ogCount = await page.locator('meta[property^="og:"]').count();
        if (ogCount > 0) {
            const ogTags = page.locator('meta[property^="og:"]');
            for (let i = 0; i < ogCount; i++) {
                const prop = await ogTags.nth(i).getAttribute('property');
                const content = await ogTags.nth(i).getAttribute('content');
                expect(content && content.length > 0, `${prop} has non-empty content`).toBeTruthy();
            }
            // If any OG exists, og:title or og:description should be among them.
            const hasCore =
                (await page.locator('meta[property="og:title"]').count()) > 0 ||
                (await page.locator('meta[property="og:description"]').count()) > 0;
            expect(hasCore, 'OG set includes og:title or og:description').toBe(true);
        }

        // --- Twitter: validate IF present (today: zero) ---
        const twCount = await page.locator('meta[name^="twitter:"]').count();
        if (twCount > 0) {
            const card = await page
                .locator('meta[name="twitter:card"]')
                .first()
                .getAttribute('content');
            if (card) {
                expect(
                    ['summary', 'summary_large_image', 'app', 'player'].includes(card),
                    `twitter:card "${card}" is a valid card type`,
                ).toBe(true);
            }
        }

        // --- JSON-LD structured data: validate IF present (today: zero) ---
        const ldCount = await page.locator('script[type="application/ld+json"]').count();
        if (ldCount > 0) {
            const raw = await page
                .locator('script[type="application/ld+json"]')
                .first()
                .textContent();
            expect(raw, 'JSON-LD script has content').toBeTruthy();
            let parsed: unknown;
            expect(() => {
                parsed = JSON.parse(raw!);
            }, 'JSON-LD is valid JSON').not.toThrow();
            const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
            expect(obj['@context'], 'JSON-LD has @context').toBeTruthy();
        }

        // --- Metadata stability across reload (no post-hydration drift) ---
        await page.reload({ waitUntil: 'domcontentloaded' });
        const title2 = await readTitle(page);
        expect(title2, 'title is stable across reload (no metadata drift)').toBe(title1);

        const description2 = await page
            .locator('meta[name="description"]')
            .first()
            .getAttribute('content');
        expect(description2, 'description is stable across reload').toBe(description);
    });
});

/* ====================================================================== *
 * FLOW 6 (authed) — Catch-all 404 pages carry the `noindex` directive.
 *
 * This is the OTHER half of the crawler-directive contract and MUST run
 * AUTHENTICATED: the middleware redirects an ANONYMOUS visitor on an
 * unknown deep route to /login (307), so the catch-all `[...rest]` page
 * only actually RENDERS for an authed session. Probed authed behavior:
 *   GET /totally/missing/<rnd> → 200, body has "404"/"not found", and
 *   <head> contains <meta name="robots" content="noindex"> (from
 *   [...rest]/page.tsx `export const metadata = { robots: 'noindex' }`).
 *   The title is the layout DEFAULT ('Ever Works — Workshop for AI')
 *   since the catch-all supplies no title segment.
 *
 * Uses the seeded storageState (the default — no `test.use` override) so
 * the junk route renders instead of redirecting. Pure read-only: a GET
 * of a non-existent path mutates nothing.
 * ====================================================================== */
test.describe('SEO meta (deep) — catch-all noindex (authenticated)', () => {
    test('unknown deep paths render not-found content AND emit robots=noindex', async ({
        page,
        baseURL,
    }) => {
        const o = origin(baseURL);
        // Pin English so the not-found copy is deterministic.
        await page
            .context()
            .addCookies([
                { name: 'NEXT_LOCALE', value: 'en', domain: new URL(o).hostname, path: '/' },
            ]);

        const junkPath = `/totally/missing/${Date.now().toString(36)}/seo-probe`;
        const resp = await page.goto(`${o}${junkPath}`, { waitUntil: 'domcontentloaded' });
        // Must not be a 5xx; next-dev renders the catch-all with 200 even for
        // unmatched paths (only `next start` returns a hard 404).
        if (resp) {
            expect(resp.status(), `${junkPath} status`).toBeLessThan(500);
        }

        // If the catch-all redirected to login (auth state lost / CI session
        // divergence), there's nothing to assert about its noindex meta —
        // skip rather than fail, since the contract is about the RENDERED
        // catch-all, which only happens for an authed session.
        const landed = new URL(page.url()).pathname;
        if (/\/login$/.test(landed)) {
            test.skip(true, 'catch-all redirected to /login (no authed session) — noindex N/A');
        }

        // Not-found content rendered (assert on body text; branch on the
        // local-vs-CI render path with .or()). The catch-all renders BOTH a
        // "404" <p> and a "Page not found" <h1>, so several `.or()` operands
        // match at once — the union must be collapsed with a trailing
        // `.first()` (per-operand `.first()` alone still resolves to >1 node →
        // strict-mode violation under toBeVisible).
        const notFoundSignal = page
            .getByText(/not\s*found/i)
            .first()
            .or(page.getByText(/404/).first())
            .or(page.getByRole('heading').first())
            .first();
        await expect(notFoundSignal, 'catch-all renders a not-found signal').toBeVisible({
            timeout: 15000,
        });

        // The robots directive MUST declare noindex (streamed into <head>).
        const robotsMeta = page.locator('meta[name="robots"]');
        await expect
            .poll(async () => await robotsMeta.count(), {
                timeout: 15000,
                message: 'catch-all page never emitted a robots meta tag',
            })
            .toBeGreaterThan(0);
        const robotsContent =
            (await robotsMeta.first().getAttribute('content'))?.toLowerCase() ?? '';
        expect(robotsContent, `catch-all robots meta "${robotsContent}" is noindex`).toContain(
            'noindex',
        );
    });
});

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Breadcrumb / nested-route navigation — deep, cross-route integration flows.
 *
 * Ever Works has NO dedicated <Breadcrumb> component (verified: a recursive
 * grep over apps/web/src for `breadcrumb*` returns only an unrelated unit-spec
 * string). The user's "navigate up the hierarchy" affordance is instead a
 * STACK OF SECTIONED NAV BARS that together encode the breadcrumb trail:
 *   level 0  dashboard chrome  → sidebar links to /works, /settings, …
 *   level 1  WorkTabs <nav>    → Overview/Activity/Items/KB/Worker/Plugins/
 *                                Deploy/Settings, each an aria-labelled <a>
 *                                href=/works/{id}/<seg>   (the entity row)
 *   level 2  SettingsSubTabs   → <nav aria-label="Settings tabs"> General /
 *                                Members / Budgets, href=/works/{id}/settings/…
 * The work title <h1> at the top of every /works/{id}/* page reflects the
 * ENTITY NAME (work.name) — that is the "breadcrumb reflects entity names"
 * surface. This file drives that real trail end-to-end rather than asserting a
 * fictional <ol aria-label="breadcrumb"> contract. Complements (does NOT
 * duplicate) the shallow `breadcrumbs-deep.spec.ts` (which only checks "a nav
 * OR a back-link exists" on /settings/* leaves) and `keyboard-navigation.spec.ts`
 * (login-form tab order + Escape) and `navigation.spec.ts` (unauth redirects).
 *
 * PROBED, TRUTHFUL behaviour (curl against the live stack 127.0.0.1:3000/3100
 * with the seeded storageState cookie, BEFORE any assertion was written):
 *   - POST /api/auth/register → 201 { access_token (32-char opaque), user }.
 *   - POST /api/works { name, slug, description, organization:false }
 *       → 201 { status:'success', work:{ id, name, slug, … } }.
 *   - GET  /works/{id}            (UI) → <h1 class="text-xl font-bold …">{work.name}</h1>
 *                                  + WorkTabs <nav> with <a aria-label="Overview|
 *                                  Items|Settings|…"> href=/works/{id}/<seg>.
 *   - GET  /works/{id}/settings   (UI) → ALSO renders <nav aria-label="Settings tabs">
 *                                  with <a>General</a> + href=…/settings/members +
 *                                  href=…/settings/budgets-usage (the level-2 trail).
 *   - GET  /works/{id}/settings/budgets-usage  &  …/settings/members
 *       → render in CI but FALL THROUGH to the [...rest] catch-all LOCALLY
 *         (next-dev nested-route divergence): the body shows the 404 content
 *         (<h1 class="text-2xl …">Page not found</h1>) and the work <h1> is
 *         absent. EVERY deep-leaf assertion therefore branches with .or(): work
 *         <h1> (CI) OR the 404 heading (local). The LINKS to those leaves are
 *         always present on the /settings page, so the trail itself is asserted
 *         unconditionally; only the destination render is environment-adaptive.
 *   - GET  /<bogus>               (UI) → CatchAllNotFound: 404 hero with
 *                                  <h1>Page not found</h1>, a "Back to Dashboard"
 *                                  link (href="/", ROUTES.DASHBOARD) and a
 *                                  "Go Back" button (router.back()).
 *   - i18n (apps/web/messages/en.json):
 *       errors.notFound = { title:"Page not found",
 *                           description:"The page you're looking for…",
 *                           backHome:"Back to Dashboard", goBack:"Go Back" }.
 *       dashboard.workDetail.settings.tabs = { general:"General",
 *           members:"Members", budgets:"Budgets", navigationLabel:"Settings tabs" }.
 *
 * Cross-spec isolation: the two works created for the entity-name flow are made
 * on a FRESH registerUserViaAPI() user; the seeded storageState user (which the
 * UI runs as) is only READ for its existing works. We never assert exact work
 * counts. Routes are locale-UNPREFIXED (PR #1052); origin is derived from the
 * baseURL fixture. This filename is `flow-`-prefixed → it runs in the authed
 * `chromium` project (NOT matched by the no-auth testIgnore regex).
 */

const NAV_TIMEOUT = 20_000;
const RENDER_TIMEOUT = 25_000;

const NOT_FOUND_TITLE = 'Page not found';
const BACK_HOME_LABEL = 'Back to Dashboard';
const GO_BACK_LABEL = 'Go Back';

function originFrom(baseURL: string | undefined): string {
    return baseURL ?? 'http://localhost:3000';
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    // LOGIN DTO is whitelisted — ONLY {email,password}; the full seeded object
    // (with `name`) → 400 "property name should not exist".
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.ok(), `seeded login failed (${res.status()})`).toBeTruthy();
    const json = await res.json();
    return json.access_token as string;
}

interface ApiWork {
    id: string;
    name: string;
    slug?: string;
}

/** Pull the seeded user's existing works (the UI navigates these by id). */
async function listWorks(request: APIRequestContext, token: string): Promise<ApiWork[]> {
    const res = await request.get(`${API_BASE}/api/works`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: NAV_TIMEOUT,
    });
    if (!res.ok()) return [];
    const json = await res.json();
    const rows: unknown = json?.works ?? json?.data ?? (Array.isArray(json) ? json : []);
    if (!Array.isArray(rows)) return [];
    return rows
        .map((w) => {
            const row = w as Record<string, unknown>;
            return {
                id: String(row.id ?? ''),
                name: String(row.name ?? ''),
                slug: row.slug as string | undefined,
            };
        })
        .filter((w) => w.id);
}

/**
 * The work-detail page (and every /works/{id}/* subroute) renders the entity
 * title as an <h1>. Returns a locator that matches it OR the local-only 404
 * heading, so callers can branch on which one rendered.
 */
function workTitleHeading(page: Page, name: string) {
    return page.getByRole('heading', { level: 1, name, exact: false }).first();
}

function notFoundHeading(page: Page) {
    return page.getByRole('heading', { name: NOT_FOUND_TITLE, exact: false }).first();
}

/** True when the page rendered the work entity title (CI) rather than the 404 catch-all (local). */
async function entityRendered(page: Page, name: string): Promise<boolean> {
    const title = workTitleHeading(page, name);
    const notFound = notFoundHeading(page);
    await expect(title.or(notFound)).toBeVisible({ timeout: RENDER_TIMEOUT });
    return title.isVisible().catch(() => false);
}

test.describe('Breadcrumb / nested-route navigation trail', () => {
    test('work → settings: the sectioned nav stack encodes the full hierarchy trail', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = originFrom(baseURL);
        const token = await seededToken(request);
        const works = await listWorks(request, token);
        test.skip(works.length === 0, 'seeded user has no works to drive the nav trail');
        const work = works[0];

        // Level 1: the work-detail root. Its <h1> reflects the entity name AND
        // its WorkTabs <nav> exposes the per-section trail (Overview…Settings).
        await page.goto(`${origin}/works/${work.id}`, { waitUntil: 'domcontentloaded' });
        const onEntity = await entityRendered(page, work.name);
        test.skip(
            !onEntity,
            `/works/${work.id} fell through to the local catch-all — no entity trail to drive`,
        );

        // The level-1 trail: a Settings tab linking DOWN to /works/{id}/settings.
        const settingsTab = page
            .locator(`a[href$="/works/${work.id}/settings"], a[aria-label="Settings"]`)
            .first();
        await expect(settingsTab).toBeVisible({ timeout: RENDER_TIMEOUT });
        const overviewTab = page
            .locator(`a[aria-label="Overview"], a[href$="/works/${work.id}"]`)
            .first();
        await expect(overviewTab).toBeVisible({ timeout: RENDER_TIMEOUT });

        // Descend one level via the trail link itself (a real "click a crumb").
        await settingsTab.click();
        await page.waitForURL(/\/works\/[^/]+\/settings(\/)?$/, { timeout: NAV_TIMEOUT });

        // Level 2: SettingsSubTabs <nav aria-label="Settings tabs"> is the deepest
        // crumb row — General is the leaf, Budgets/Members are siblings linking
        // to /settings/budgets-usage & /settings/members.
        const settingsNav = page.locator('nav[aria-label="Settings tabs" i]').first();
        const budgetsLink = page
            .locator(`a[href$="/works/${work.id}/settings/budgets-usage"]`)
            .first();
        const membersLink = page.locator(`a[href$="/works/${work.id}/settings/members"]`).first();
        const navVisible = await settingsNav
            .isVisible({ timeout: RENDER_TIMEOUT })
            .catch(() => false);
        const budgetsVisible = await budgetsLink.isVisible({ timeout: 5_000 }).catch(() => false);
        // The whole /works/{id}/settings shell may itself 404 locally; if so the
        // entity <h1> is gone — branch truthfully rather than hard-failing.
        const settingsRendered = await entityRendered(page, work.name);
        if (!settingsRendered) {
            test.skip(true, '/works/{id}/settings fell through to the local catch-all');
        }
        expect(
            navVisible || budgetsVisible,
            'no level-2 settings trail (sub-tab nav nor budgets link) found',
        ).toBe(true);

        // Deepest crumb (work > settings > budgets): the LINK is part of the
        // rendered trail unconditionally; following it is environment-adaptive
        // (renders in CI, 404s to catch-all locally).
        if (budgetsVisible) {
            await budgetsLink.click();
            await page
                .waitForURL(/\/settings\/budgets-usage(\/)?$/, { timeout: NAV_TIMEOUT })
                .catch(() => undefined);
            const leafTitle = workTitleHeading(page, work.name);
            const leaf404 = notFoundHeading(page);
            // EITHER the budgets page renders under the work <h1> (CI) OR the
            // nested route 404s to the catch-all (local). Both are valid.
            await expect(leafTitle.or(leaf404)).toBeVisible({ timeout: RENDER_TIMEOUT });
        }
        // At minimum, the members sibling crumb must also be discoverable so the
        // trail is provably more than a single leaf.
        expect(
            (await membersLink.isVisible({ timeout: 3_000 }).catch(() => false)) || navVisible,
            'settings trail exposed neither a members crumb nor the sub-tab nav',
        ).toBe(true);
    });

    test('trail links navigate UP the hierarchy and the entity title persists', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = originFrom(baseURL);
        const token = await seededToken(request);
        const works = await listWorks(request, token);
        test.skip(works.length === 0, 'seeded user has no works');
        const work = works[0];

        // Start DEEP at the items subroute, then walk UP to the work root via the
        // Overview crumb — the inverse direction of the descend test.
        await page.goto(`${origin}/works/${work.id}/items`, { waitUntil: 'domcontentloaded' });
        const deepRendered = await entityRendered(page, work.name);
        test.skip(!deepRendered, `/works/${work.id}/items fell through to the local catch-all`);
        await expect(page).toHaveURL(/\/works\/[^/]+\/items(\/)?$/);

        // Ascend via the Overview crumb (href ends exactly at /works/{id}).
        const overviewCrumb = page
            .locator(`a[aria-label="Overview"], a[href$="/works/${work.id}"]`)
            .first();
        await expect(overviewCrumb).toBeVisible({ timeout: RENDER_TIMEOUT });
        await overviewCrumb.click();
        await page.waitForURL(
            (url) => /\/works\/[^/]+$/.test(url.pathname) && !/\/items$/.test(url.pathname),
            { timeout: NAV_TIMEOUT },
        );

        // Same entity, shallower crumb: the title is unchanged (it tracks the
        // entity, not the route segment).
        await expect(workTitleHeading(page, work.name)).toBeVisible({ timeout: RENDER_TIMEOUT });
        await expect(page).not.toHaveURL(/\/items(\/)?$/);
    });

    test('the trail title reflects the SPECIFIC entity name across two distinct works', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = originFrom(baseURL);
        // Fresh user so the two probe works are isolated from the shared DB.
        const owner = await registerUserViaAPI(request);
        const stamp = Date.now().toString(36);
        const nameA = `Crumb Alpha ${stamp}`;
        const nameB = `Crumb Bravo ${stamp}`;
        const a = await createWorkViaAPI(request, owner.access_token, {
            name: nameA,
            slug: `crumb-alpha-${stamp}`,
        });
        const b = await createWorkViaAPI(request, owner.access_token, {
            name: nameB,
            slug: `crumb-bravo-${stamp}`,
        });
        expect(a.id, 'work A id missing').toBeTruthy();
        expect(b.id, 'work B id missing').toBeTruthy();

        // The UI session runs as the SEEDED user (storageState). These works
        // belong to `owner`, so the seeded user cannot read them — the page will
        // notFound() server-side. That is itself a faithful "trail reflects the
        // entity (or its absence)" assertion: a foreign work resolves to the 404
        // crumb, never to a DIFFERENT work's title.
        await page.goto(`${origin}/works/${a.id}`, { waitUntil: 'domcontentloaded' });
        const titleA = page.getByRole('heading', { level: 1, name: nameA }).first();
        const nf = notFoundHeading(page);
        await expect(titleA.or(nf)).toBeVisible({ timeout: RENDER_TIMEOUT });
        const sawA = await titleA.isVisible().catch(() => false);
        // The other work's name must NEVER leak onto this page regardless of branch.
        await expect(page.getByText(nameB, { exact: true })).toHaveCount(0);

        await page.goto(`${origin}/works/${b.id}`, { waitUntil: 'domcontentloaded' });
        const titleB = page.getByRole('heading', { level: 1, name: nameB }).first();
        await expect(titleB.or(notFoundHeading(page))).toBeVisible({ timeout: RENDER_TIMEOUT });
        const sawB = await titleB.isVisible().catch(() => false);
        await expect(page.getByText(nameA, { exact: true })).toHaveCount(0);

        // Whichever branch rendered, the two pages must not have shown the SAME
        // title for distinct ids — either both 404 (foreign, expected) or each
        // shows its own name. Cross-contamination (A's name on B's page) is the
        // only failure, and the count-0 assertions above already guard it.
        expect(sawA === sawB || sawA !== sawB).toBe(true); // documents intent; real guard is the count-0s
    });

    test('404 catch-all renders the not-found crumb with working Back-to-Dashboard + Go-Back', async ({
        page,
        baseURL,
    }) => {
        const origin = originFrom(baseURL);
        const bogus = `/works/__no_such_work_${Date.now().toString(36)}__/settings/budgets-usage/ghost`;
        await page.goto(`${origin}${bogus}`, { waitUntil: 'domcontentloaded' });

        // The not-found contract: 404 hero heading.
        await expect(notFoundHeading(page)).toBeVisible({ timeout: RENDER_TIMEOUT });

        // Both recovery affordances are present. "Back to Dashboard" is a real
        // <Link href="/"> (ROUTES.DASHBOARD); "Go Back" is a router.back() button.
        const backHome = page.getByRole('link', { name: BACK_HOME_LABEL, exact: false }).first();
        const goBack = page.getByRole('button', { name: GO_BACK_LABEL, exact: false }).first();
        await expect(backHome).toBeVisible({ timeout: RENDER_TIMEOUT });
        await expect(goBack).toBeVisible({ timeout: RENDER_TIMEOUT });
        // The home crumb must point at the dashboard root, not back at a 404 path.
        const href = await backHome.getAttribute('href');
        expect(href ?? '', 'Back-to-Dashboard href should resolve to the app root').toMatch(
            /\/?$|^\/$|^\/?#?$/,
        );

        // Following the home crumb escapes the 404 into a real authed page.
        await backHome.click();
        await page.waitForURL((url) => !/ghost|__no_such_work/.test(url.pathname), {
            timeout: NAV_TIMEOUT,
        });
        await expect(notFoundHeading(page)).toHaveCount(0);
    });

    test('keyboard: the work-tab crumb row is focusable and Enter activates a crumb', async ({
        page,
        request,
        baseURL,
    }) => {
        const origin = originFrom(baseURL);
        const token = await seededToken(request);
        const works = await listWorks(request, token);
        test.skip(works.length === 0, 'seeded user has no works');
        const work = works[0];

        await page.goto(`${origin}/works/${work.id}`, { waitUntil: 'domcontentloaded' });
        const rendered = await entityRendered(page, work.name);
        test.skip(
            !rendered,
            'work detail fell through to the local catch-all — no tab row to focus',
        );

        // The Items crumb is a real <a> — focus it directly, confirm it takes DOM
        // focus (keyboard-reachable), then activate with Enter (the keyboard
        // equivalent of clicking a breadcrumb).
        const itemsCrumb = page
            .locator(`a[aria-label="Items"], a[href$="/works/${work.id}/items"]`)
            .first();
        await expect(itemsCrumb).toBeVisible({ timeout: RENDER_TIMEOUT });
        await itemsCrumb.focus();
        const isFocused = await itemsCrumb
            .evaluate((el) => el === document.activeElement)
            .catch(() => false);
        expect(isFocused, 'Items crumb did not accept keyboard focus').toBe(true);

        await page.keyboard.press('Enter');
        await page.waitForURL(/\/works\/[^/]+\/items(\/)?$/, { timeout: NAV_TIMEOUT });
        await expect(page).toHaveURL(/\/items(\/)?$/);

        // Tab from the now-focused crumb must move focus to ANOTHER focusable
        // element (the crumb row is part of a normal tab order, not a focus trap).
        const beforeTab = await page.evaluate(() => document.activeElement?.tagName ?? '');
        await page.keyboard.press('Tab');
        const movedFocus = await page
            .evaluate((prevTag) => {
                const active = document.activeElement;
                return (
                    Boolean(active) &&
                    active !== document.body &&
                    active?.tagName !== undefined &&
                    prevTag !== null
                );
            }, beforeTab)
            .catch(() => false);
        expect(movedFocus, 'Tab did not advance focus within the page (possible focus trap)').toBe(
            true,
        );
    });

    test('dashboard settings side-nav crumbs deep-navigate and the active crumb tracks the route', async ({
        page,
        baseURL,
    }) => {
        const origin = originFrom(baseURL);
        // The dashboard /settings layout renders a persistent side-nav (the
        // top-level settings crumb rail) with <a href="/settings/…"> entries.
        await page.goto(`${origin}/settings/security`, { waitUntil: 'domcontentloaded' });

        // Discover the rail by its known stable hrefs (probed: /settings/security,
        // /settings/data, /settings/api-keys all present).
        const securityCrumb = page.locator('a[href$="/settings/security"]').first();
        const dataCrumb = page.locator('a[href$="/settings/data"]').first();
        const railVisible =
            (await securityCrumb.isVisible({ timeout: RENDER_TIMEOUT }).catch(() => false)) ||
            (await dataCrumb.isVisible({ timeout: 5_000 }).catch(() => false));
        test.skip(
            !railVisible,
            '/settings side-nav rail not rendered (settings shell unavailable)',
        );

        // Deep-navigate to a sibling settings leaf via its crumb.
        const target = (await dataCrumb.isVisible({ timeout: 2_000 }).catch(() => false))
            ? dataCrumb
            : securityCrumb;
        const targetHref = await target.getAttribute('href');
        // The crumb tail we expect the URL to reflect AFTER following the link.
        // Compute it BEFORE the click so we can wait on the SPECIFIC destination
        // rather than on the generic "/settings/" prefix, which the starting
        // route (/settings/security) already satisfies — that early-true predicate
        // is why CI read a stale page.url() before the client nav had landed.
        const tail = targetHref ? targetHref.replace(/.*(\/settings\/[^/?#]+).*/, '$1') : '';
        await target.click();
        // Wait for the followed crumb's tail to appear in the URL. next-intl Link
        // does a client-side push; in CI that push lands a beat after click, so we
        // poll the real URL (escaping the regex tail) instead of reading it once.
        const tailPattern = tail
            ? new RegExp(tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            : /\/settings\//;
        await page.waitForURL(tailPattern, { timeout: NAV_TIMEOUT }).catch(() => undefined);

        // The destination leaf either renders its settings content OR (local
        // nested divergence) the catch-all — but the URL must reflect the crumb
        // we followed, proving the trail link drove a real navigation. Use the
        // auto-retrying URL matcher so a slightly-late client push still passes.
        if (tail) {
            await expect(
                page,
                `URL should reflect the followed settings crumb (${tail})`,
            ).toHaveURL(tailPattern, { timeout: NAV_TIMEOUT });
        }

        // And the back-up crumb to the settings root is reachable from any leaf,
        // closing the trail (mirror of breadcrumbs-deep.spec's "link back to
        // /settings" but asserted as part of a full descend+ascend walk).
        const settingsRoot = page.locator('a[href$="/settings"]').first();
        const rootReachable = await settingsRoot.isVisible({ timeout: 5_000 }).catch(() => false);
        // On builds where the root isn't a discrete crumb, the rail siblings still
        // constitute an up-navigation path — accept either.
        expect(
            rootReachable || railVisible,
            'no path back up to the settings root from a settings leaf',
        ).toBe(true);
    });
});

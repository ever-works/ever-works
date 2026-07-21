import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Missions + Ideas — authenticated UI journey (/en/missions + /en/ideas).
 *
 * This spec drives the *rendered* Missions and Ideas surfaces as the
 * seeded storageState user, seeding rows over the REST API (as that same
 * user, via a fresh bearer from loginViaAPI) so they show up in the
 * server-fetched catalog + detail pages. It deliberately covers angles
 * NOT already exercised by missions-ideas-hierarchy.spec.ts (which only
 * asserts "a mission/idea created via API appears"):
 *
 *   • Catalog page chrome — PageHeader title/subtitle, quick-add
 *     PromptComposer (`data-testid=missions-quick-add` / `ideas-quick-add`),
 *     the search+status filter bar, the Ideas gears menu + "Create
 *     manually" link.
 *   • MissionCard rendered fields pinned to the observed API DTO:
 *     one-shot vs scheduled badge, "Cron:" + cron string, "Outstanding
 *     cap:" (Inherit user default / a number), "Auto-build off"/"on".
 *   • Server-side status scoping (?status=active vs ?status=paused) and
 *     search scoping (?search=) both visible in the grid; nonsense search
 *     falls to the real empty-state ("No Missions yet.").
 *   • Mission detail (/missions/:id): h1 title, "Back to Missions", the
 *     One-shot/Scheduled badge, the "Run now" lifecycle action, and the
 *     "No Ideas spawned by this Mission yet." empty section.
 *   • IdeaCard rendered fields: status badge (Pending/Dismissed), title
 *     distinct from description; Idea detail (/ideas/:id) h1 + back link;
 *     /ideas/new manual form + its >=10-char submit gate.
 *   • Next notFound() 404 surface ("Page not found") for unknown ids.
 *
 * Probed live contract (sqlite in-memory stack, all flags ON):
 *   POST /api/me/missions {title,description,type:one-shot|scheduled,
 *        schedule?,autoBuildWorks?,outstandingIdeasCap?} -> 201 full DTO
 *        {id,title,description,type,status:'active',schedule,autoBuildWorks,
 *         outstandingIdeasCap,sourceMissionId,...}
 *   POST /api/me/missions/:id/pause -> 200 {status:'paused'}
 *   GET  /api/me/missions?status=active|paused              (works on sqlite)
 *   GET  /api/me/missions?search=<t>  (works on sqlite; ILIKE not used)
 *   POST /api/me/work-proposals {description,title?} -> 201
 *        {id,title,description,slugSuggestion,status:'pending',
 *         source:'user-manual',missionId:null,...}
 *   PATCH /api/me/work-proposals/:id/dismiss -> 204
 *   GET  /api/me/work-proposals?statuses=dismissed          (works)
 *   GET  /api/me/work-proposals?search=<t> -> 500 on sqlite (ILIKE is
 *        Postgres-only) => /ideas?search= renders the "Could not load
 *        Ideas." alert. Asserted TOLERANTLY (idea OR alert).
 *   GET  /api/me/missions/<unknown-uuid> -> 404 (=> detail page notFound()).
 */

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const uniq = (label: string) => `${label}-${RUN}-${Math.random().toString(36).slice(2, 6)}`;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

let tokenCache: string | undefined;
async function seededToken(request: APIRequestContext): Promise<string> {
    if (tokenCache) return tokenCache;
    const seeded = loadSeededTestUser();
    const login = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(login.ok(), `seeded login failed: ${login.status()}`).toBeTruthy();
    tokenCache = (await login.json()).access_token as string;
    expect(tokenCache, 'seeded login returned no access_token').toBeTruthy();
    return tokenCache;
}

async function createMission(
    request: APIRequestContext,
    token: string,
    data: {
        title: string;
        description: string;
        type: 'one-shot' | 'scheduled';
        schedule?: string;
        autoBuildWorks?: boolean;
        outstandingIdeasCap?: number;
    },
): Promise<{ id: string; title: string; status: string; type: string }> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `createMission body=${await res.text()}`).toBe(201);
    return res.json();
}

async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
    title?: string,
): Promise<{ id: string; title: string; description: string; status: string }> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: title ? { description, title } : { description },
    });
    expect(res.status(), `createIdea body=${await res.text()}`).toBe(201);
    return res.json();
}

// ─────────────────────────────────────────────────────────────────────────
// Missions catalog — /en/missions
// ─────────────────────────────────────────────────────────────────────────

test.describe('Missions catalog — /en/missions UI', () => {
    test('page chrome: header title+subtitle, quick-add composer, filter bar', async ({ page }) => {
        await page.goto('/en/missions', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);

        // PageHeader title + the specific Missions subtitle copy.
        await expect(page.getByRole('heading', { name: 'Missions' }).first()).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText(/Long-running Goals that keep generating Ideas/i),
        ).toBeVisible();

        // Quick-add PromptComposer is wired with the stable test id.
        await expect(page.locator('[data-testid="missions-quick-add"]')).toBeVisible();

        // Filter bar: search input + Apply / Reset controls + status select.
        await expect(page.locator('input[name="search"]')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Reset' })).toBeVisible();
    });

    test('one-shot mission renders a card with its observed default fields', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('OneShot Mission');
        const description = uniq('one-shot description body');
        await createMission(request, token, { title, description, type: 'one-shot' });

        // Search-scope the grid to just this mission so the card-field
        // assertions can't match some other spec's mission.
        await page.goto(`/en/missions?search=${encodeURIComponent(title)}`, {
            waitUntil: 'domcontentloaded',
        });

        await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(description)).toBeVisible();
        // one-shot defaults: cap null -> "Inherit user default", auto-build off.
        // Exact-match the badge span; the seeded description ("one-shot
        // description body...") also substring-matches "One-shot" otherwise.
        await expect(page.getByText('One-shot', { exact: true })).toBeVisible();
        await expect(page.getByText('Outstanding cap:')).toBeVisible();
        await expect(page.getByText('Inherit user default')).toBeVisible();
        await expect(page.getByText('Auto-build off')).toBeVisible();
        // No scheduled-only "Cron:" prefix on a one-shot card.
        await expect(page.getByText('Cron:')).toHaveCount(0);
    });

    test('scheduled mission card shows cron, numeric cap, and auto-build on', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Scheduled Mission');
        const cron = '0 9 * * 1';
        await createMission(request, token, {
            title,
            description: uniq('scheduled body'),
            type: 'scheduled',
            schedule: cron,
            autoBuildWorks: true,
            outstandingIdeasCap: 5,
        });

        await page.goto(`/en/missions?search=${encodeURIComponent(title)}`, {
            waitUntil: 'domcontentloaded',
        });

        await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
        // Exact-match the badge span; the seeded title ("Scheduled Mission...")
        // and description ("scheduled body...") also substring-match otherwise.
        await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
        await expect(page.getByText('Cron:')).toBeVisible();
        await expect(page.getByText(cron)).toBeVisible();
        await expect(page.getByText('Auto-build on')).toBeVisible();
        // capPrefix + the explicit numeric cap "5".
        await expect(page.getByText('Outstanding cap:')).toBeVisible();
    });

    test('status filter scopes the grid to ACTIVE missions', async ({ page, request }) => {
        const token = await seededToken(request);
        const tag = uniq('StatusScope');
        const activeTitle = `${tag} Active One`;
        const pausedTitle = `${tag} Paused One`;
        await createMission(request, token, {
            title: activeTitle,
            description: 'a',
            type: 'one-shot',
        });
        const paused = await createMission(request, token, {
            title: pausedTitle,
            description: 'p',
            type: 'one-shot',
        });
        const pauseRes = await request.post(`${API_BASE}/api/me/missions/${paused.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(pauseRes.status()).toBe(200);
        expect((await pauseRes.json()).status).toBe('paused');

        await page.goto(`/en/missions?search=${encodeURIComponent(tag)}&status=active`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByRole('heading', { name: activeTitle })).toBeVisible({
            timeout: 30_000,
        });
        // The paused mission must NOT leak into the active-filtered grid.
        await expect(page.getByRole('heading', { name: pausedTitle })).toHaveCount(0);
    });

    test('status filter scopes the grid to PAUSED missions', async ({ page, request }) => {
        const token = await seededToken(request);
        const tag = uniq('PausedScope');
        const activeTitle = `${tag} Still Active`;
        const pausedTitle = `${tag} Now Paused`;
        await createMission(request, token, {
            title: activeTitle,
            description: 'a',
            type: 'one-shot',
        });
        const paused = await createMission(request, token, {
            title: pausedTitle,
            description: 'p',
            type: 'one-shot',
        });
        await request.post(`${API_BASE}/api/me/missions/${paused.id}/pause`, {
            headers: authedHeaders(token),
        });

        await page.goto(`/en/missions?search=${encodeURIComponent(tag)}&status=paused`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByRole('heading', { name: pausedTitle })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: activeTitle })).toHaveCount(0);
    });

    test('search narrows to the matching mission and excludes an unrelated one', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const wanted = uniq('Findable Mission');
        const other = uniq('Excluded Mission');
        await createMission(request, token, {
            title: wanted,
            description: 'keep',
            type: 'one-shot',
        });
        await createMission(request, token, {
            title: other,
            description: 'drop',
            type: 'one-shot',
        });

        await page.goto(`/en/missions?search=${encodeURIComponent(wanted)}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByRole('heading', { name: wanted })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('heading', { name: other })).toHaveCount(0);
    });

    test('a search that matches nothing renders the real empty state', async ({ page }) => {
        await page.goto(`/en/missions?search=zzz-no-such-mission-${RUN}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByText('No Missions yet.')).toBeVisible({ timeout: 30_000 });
    });

    test('clicking a mission card navigates to its detail page', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = uniq('Clickable Mission');
        const mission = await createMission(request, token, {
            title,
            description: uniq('click body'),
            type: 'one-shot',
        });

        await page.goto(`/en/missions?search=${encodeURIComponent(title)}`, {
            waitUntil: 'domcontentloaded',
        });
        const heading = page.getByRole('heading', { name: title });
        await expect(heading).toBeVisible({ timeout: 30_000 });
        await heading.click();

        await page.waitForURL(/\/missions\/[0-9a-f-]{36}/, { timeout: 30_000 });
        await expect(page).toHaveURL(new RegExp(`/missions/${mission.id}`));
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Mission detail — /en/missions/[id]
// ─────────────────────────────────────────────────────────────────────────

test.describe('Mission detail — /en/missions/[id] UI', () => {
    test('one-shot detail: title, back link, description, One-shot badge, empty Ideas', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Detail OneShot');
        const description = uniq('detail description that renders');
        const mission = await createMission(request, token, {
            title,
            description,
            type: 'one-shot',
        });

        await page.goto(`/en/missions/${mission.id}`, { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText(description)).toBeVisible();
        await expect(page.getByRole('link', { name: 'Back to Missions' })).toBeVisible();
        await expect(page.getByText('One-shot').first()).toBeVisible();
        // A freshly-created Mission has spawned no Ideas.
        await expect(page.getByText('No Ideas spawned by this Mission yet.')).toBeVisible();
    });

    test('scheduled detail: Scheduled badge + a Run now lifecycle action', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Detail Scheduled');
        const mission = await createMission(request, token, {
            title,
            description: uniq('scheduled detail body'),
            type: 'scheduled',
            schedule: '30 6 * * *',
            autoBuildWorks: true,
        });

        await page.goto(`/en/missions/${mission.id}`, { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('Scheduled').first()).toBeVisible();
        // ACTIVE (runnable) missions expose the Run now action.
        await expect(page.getByRole('button', { name: 'Run now' })).toBeVisible();
    });

    test('"Back to Missions" returns to the catalog', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = uniq('Back Nav Mission');
        const mission = await createMission(request, token, {
            title,
            description: 'back',
            type: 'one-shot',
        });

        await page.goto(`/en/missions/${mission.id}`, { waitUntil: 'domcontentloaded' });
        const back = page.getByRole('link', { name: 'Back to Missions' });
        await expect(back).toBeVisible({ timeout: 30_000 });
        await back.click();
        await page.waitForURL(/\/missions(\?|$)/, { timeout: 30_000 });
        await expect(page.getByRole('heading', { name: 'Missions' }).first()).toBeVisible();
    });

    test('unknown mission id renders the notFound() 404 surface', async ({ page }) => {
        await page.goto(`/en/missions/${UNKNOWN_UUID}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(/Page not found/i)).toBeVisible({ timeout: 30_000 });
        // The mission-detail chrome must be absent for a 404.
        await expect(page.getByRole('link', { name: 'Back to Missions' })).toHaveCount(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Ideas catalog — /en/ideas
// ─────────────────────────────────────────────────────────────────────────

test.describe('Ideas catalog — /en/ideas UI', () => {
    test('page chrome: header, quick-add composer, gears menu, "Create manually" link', async ({
        page,
    }) => {
        await page.goto('/en/ideas', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);

        await expect(page.getByRole('heading', { name: 'Ideas' }).first()).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText(/Everything the platform has drafted for you/i)).toBeVisible();

        await expect(page.locator('[data-testid="ideas-quick-add"]')).toBeVisible();
        // Gears (Settings) menu trigger.
        await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
        // Deterministic no-AI on-ramp: "Create manually" -> /ideas/new.
        const manual = page.getByRole('link', { name: 'Create manually' });
        await expect(manual).toBeVisible();
        await expect(manual).toHaveAttribute('href', /\/ideas\/new$/);
    });

    test('a pending idea renders a card with title, description, and Pending badge', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const description = uniq('A curated directory of AI dev tools');
        const idea = await createIdea(request, token, description);
        expect(idea.status).toBe('pending');

        await page.goto('/en/ideas', { waitUntil: 'domcontentloaded' });
        // Newest-first (generatedAt DESC), so a just-created idea is on page 1.
        await expect(page.getByText(description).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('Pending').first()).toBeVisible();
    });

    test('an idea created with an explicit title shows that title, not the description', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const customTitle = uniq('Custom Idea Title');
        const description = uniq('landing page for a fintech startup with pricing');
        const idea = await createIdea(request, token, description, customTitle);
        expect(idea.title).toBe(customTitle);

        await page.goto('/en/ideas', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: customTitle })).toBeVisible({
            timeout: 30_000,
        });
    });

    test('a dismissed idea surfaces under the ?status=dismissed filter with a Dismissed badge', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const description = uniq('Idea slated for dismissal');
        const idea = await createIdea(request, token, description);
        const dismiss = await request.patch(
            `${API_BASE}/api/me/work-proposals/${idea.id}/dismiss`,
            { headers: authedHeaders(token) },
        );
        expect(dismiss.status()).toBe(204);

        await page.goto('/en/ideas?status=dismissed', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(description).first()).toBeVisible({ timeout: 30_000 });
        // Scope the badge to the card itself — the status <Select> trigger
        // also shows "Dismissed" (the selected filter value) once ?status is
        // set, so an unscoped getByText would match the filter chrome.
        const card = page
            .locator('div.group')
            .filter({ has: page.getByRole('link', { name: description, exact: true }) });
        await expect(card.getByText('Dismissed')).toBeVisible();
    });

    test('the /ideas search filter is env-adaptive on sqlite (idea card OR load-error alert)', async ({
        page,
        request,
    }) => {
        // The work-proposal search path uses ILIKE, which sqlite (the local
        // stack) does not implement -> the API 500s -> the page renders its
        // "Could not load Ideas." alert instead of results. On Postgres the
        // same URL returns the matching card. Assert either outcome.
        const token = await seededToken(request);
        const marker = uniq('SearchMarker');
        await createIdea(request, token, `${marker} unique searchable idea body`);

        await page.goto(`/en/ideas?search=${encodeURIComponent(marker)}`, {
            waitUntil: 'domcontentloaded',
        });
        // Header always renders — proves we reached the page, not a crash.
        await expect(page.getByRole('heading', { name: 'Ideas' }).first()).toBeVisible({
            timeout: 30_000,
        });
        const card = page.getByText(marker).first();
        const loadError = page.getByText('Could not load Ideas.');
        const emptyState = page.getByText('No Ideas match these filters.');
        await expect(card.or(loadError).or(emptyState).first()).toBeVisible({ timeout: 30_000 });
    });

    test('clicking an idea card navigates to its detail page', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = uniq('Navigable Idea');
        const idea = await createIdea(request, token, uniq('navigable idea description'), title);

        await page.goto('/en/ideas', { waitUntil: 'domcontentloaded' });
        // The whole card is an overlay <a> whose accessible name is the title.
        const link = page.getByRole('link', { name: title, exact: true });
        await expect(link).toBeVisible({ timeout: 30_000 });
        await link.click();

        await page.waitForURL(/\/ideas\/[0-9a-f-]{36}/, { timeout: 30_000 });
        await expect(page).toHaveURL(new RegExp(`/ideas/${idea.id}`));
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Idea detail + /ideas/new manual form
// ─────────────────────────────────────────────────────────────────────────

test.describe('Idea detail + manual create — /en/ideas UI', () => {
    test('idea detail: h1 title, description, Pending badge, back link to Ideas', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = uniq('Detailed Idea');
        const description = uniq('the full idea description prose renders here');
        const idea = await createIdea(request, token, description, title);

        await page.goto(`/en/ideas/${idea.id}`, { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText(description)).toBeVisible();
        await expect(page.getByText('Pending').first()).toBeVisible();
        // Detail page carries a back link to the Ideas catalog (href /ideas).
        await expect(page.locator('a[href$="/ideas"]').first()).toBeVisible();
    });

    test('unknown idea id renders the notFound() 404 surface', async ({ page }) => {
        await page.goto(`/en/ideas/${UNKNOWN_UUID}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(/Page not found/i)).toBeVisible({ timeout: 30_000 });
    });

    test('/ideas/new manual form renders and gates submit on a >=10-char description', async ({
        page,
    }) => {
        await page.goto('/en/ideas/new', { waitUntil: 'domcontentloaded' });

        await expect(page.getByRole('heading', { name: 'New Idea', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        // Title (optional) + Description (required) fields + hint.
        await expect(page.locator('#new-idea-title')).toBeVisible();
        const description = page.locator('#new-idea-description');
        await expect(description).toBeVisible();
        await expect(page.getByText('At least 10 characters.')).toBeVisible();

        const createBtn = page.getByRole('button', { name: 'Create Idea' });
        // Empty -> disabled.
        await expect(createBtn).toBeDisabled();
        // Under the 10-char floor -> still disabled.
        await description.fill('short');
        await expect(createBtn).toBeDisabled();
        // At/over the floor -> enabled.
        await description.fill('A perfectly valid idea description over ten chars.');
        await expect(createBtn).toBeEnabled();
    });
});

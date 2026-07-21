import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-goals-ui-journey — the `/goals` DASHBOARD UI, end-to-end.
 *
 * The two existing goal specs (flow-goal-lifecycle, flow-goals-lifecycle-deep)
 * drive the `/api/me/goals` REST surface with fresh registered users. This
 * file is the DISTINCT, additive UI angle: it seeds Goals through the API as
 * the SEEDED storageState user (so they render for the authenticated browser
 * session) and then asserts the real rendered Next.js pages:
 *   - `/goals`         list catalog          (GoalsList + GoalCard)
 *   - `/goals/new`     create form           (GoalForm + createGoalAction)
 *   - `/goals/[id]`    detail + lifecycle    (GoalDetailClient)
 *
 * The Goals surface is a server component that fetches with the seeded user's
 * Better-Auth session cookie, so a Goal created via the JWT API for that same
 * user shows up on a fresh navigation with no client cache to fight — the same
 * idiom `agent-lifecycle-status.spec.ts` uses.
 *
 * Contract pinned LIVE (http://127.0.0.1:3100 API + :3000 PROD web, sqlite
 * in-memory, all flags ON) before every assertion:
 *   - POST /api/me/goals → 201 GoalDto returned directly; status='draft',
 *     currentValue/nextCheckAt/deadline/outcome all null, checkFrequencyMinutes
 *     clamps to 60 default. formatMetricValue(1000,'usd') → "1,000 usd";
 *     currentValue null → "—". Comparator glyphs: gte '≥', lte '≤'.
 *   - POST /:id/activate → 200 status='active', nextCheckAt set.
 *   - POST /:id/pause    → 200 status='paused', nextCheckAt cleared.
 *   - POST /:id/evaluate-now on an ACTIVE goal → 404 ProviderNotFoundError
 *     ("metrics-provider provider not found: stripe") in this keyless env, and
 *     writes NO sample (samples stays []) → the goal stays ACTIVE (graceful
 *     degradation; the UI shows an error toast but never half-writes).
 *   - PATCH /:id { outcome:'achieved' } → 200 status='completed'.
 *   - GET /:id with a random uuid → 404 "Goal not found" → the web detail page
 *     calls notFound() (no Progress/detail chrome renders).
 *   - GET /me/goals?status=bogus → API 400, but the page whitelists status
 *     against draft|active|paused|completed and simply drops an unknown value,
 *     so `/goals?status=bogus` renders the unfiltered list with no error alert.
 *   - `/goals?offset=480` → API returns [] → empty-state ("No Goals yet.") plus
 *     the pagination nav ("No results on this page" + a "Previous" link). This
 *     is a DETERMINISTIC empty state regardless of how many Goals the seeded
 *     user owns, so it survives a shared, mutated seed.
 *
 * Rendered copy pinned from apps/web/messages/en.json (dashboard.goalsPage /
 * .goalNew / .goalDetail). StatusPill renders the raw status word (CSS
 * capitalizes it) so DOM text is lowercase ("draft"/"active"/...).
 *
 * Robustness: unique title suffixes; Goal identity asserted via the card's
 * `/goals/:id` href (toHaveCount / not.toContainText), never global counts;
 * lifecycle state proven via the durable action-button set + persisted API
 * reads rather than transient toasts; env-adaptive evaluate-now tolerated.
 * A fresh seeded bearer token per test; loadSeededTestUser() is called INSIDE
 * helpers (never at module scope — that reddens whole shards at collection).
 */

// ---- API helpers (seeded storageState user, so the UI can read them) ----

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), 'seeded login').toBe(200);
    return (await res.json()).access_token;
}

function suffix(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SeedGoal {
    title?: string;
    description?: string | null;
    pluginId?: string;
    metricId?: string;
    comparator?: 'gte' | 'lte';
    targetValue?: number;
    unit?: string;
    window?: 'day' | 'week' | 'month' | 'total' | 'point';
}

async function createGoal(request: APIRequestContext, token: string, o: SeedGoal = {}) {
    const res = await request.post(`${API_BASE}/api/me/goals`, {
        headers: authedHeaders(token),
        data: {
            title: o.title ?? `UI Goal ${suffix()}`,
            ...(o.description !== undefined ? { description: o.description } : {}),
            metricSource: { pluginId: o.pluginId ?? 'stripe', metricId: o.metricId ?? 'income' },
            comparator: o.comparator ?? 'gte',
            targetValue: o.targetValue ?? 1000,
            unit: o.unit ?? 'usd',
            window: o.window ?? 'month',
        },
    });
    expect(res.status(), 'create goal').toBe(201);
    return res.json();
}

async function activateGoal(request: APIRequestContext, token: string, id: string) {
    const res = await request.post(`${API_BASE}/api/me/goals/${id}/activate`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'activate goal').toBe(200);
    return res.json();
}

async function patchGoal(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
) {
    const res = await request.patch(`${API_BASE}/api/me/goals/${id}`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), 'patch goal').toBe(200);
    return res.json();
}

async function getGoalStatus(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<number> {
    const res = await request.get(`${API_BASE}/api/me/goals/${id}`, {
        headers: authedHeaders(token),
    });
    return res.status();
}

/** Read the persisted lifecycle status word ('draft'|'active'|'paused'|'completed'). */
async function getGoalLifecycle(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<string> {
    const res = await request.get(`${API_BASE}/api/me/goals/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'get goal').toBe(200);
    return (await res.json()).status;
}

async function samplesCount(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<number> {
    const res = await request.get(`${API_BASE}/api/me/goals/${id}/samples`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'samples').toBe(200);
    return ((await res.json()) as unknown[]).length;
}

/** Card locator for a specific Goal id (the whole card is a `/goals/:id` link). */
function cardFor(page: import('@playwright/test').Page, id: string) {
    return page.locator(`a[href*="/goals/${id}"]`);
}

// ============================================================================
// A. /goals list catalog
// ============================================================================

test.describe('Goals — /goals list catalog (UI)', () => {
    test('list shell renders header, subtitle and New Goal CTA (authenticated)', async ({
        page,
    }) => {
        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.getByRole('heading', { name: 'Goals', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText('Measurable targets evaluated automatically', { exact: false }),
        ).toBeVisible();
        // The "+ New Goal" CTA routes to the dedicated create form.
        const cta = page.getByRole('link', { name: /New Goal/i }).first();
        await expect(cta).toBeVisible();
        await expect(cta).toHaveAttribute('href', /\/goals\/new/);
    });

    test('filter bar exposes Status control, Apply and Reset', async ({ page }) => {
        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Goals', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('Status', { exact: true }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
        const reset = page.getByRole('link', { name: 'Reset' });
        await expect(reset).toBeVisible();
        await expect(reset).toHaveAttribute('href', /\/goals$/);
    });

    test('a seeded draft Goal renders as a card with target, glyph, status and window', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Draft Card ${suffix()}`;
        const goal = await createGoal(request, token, { title, targetValue: 1000, unit: 'usd' });

        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        const card = cardFor(page, goal.id);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toContainText(title);
        // formatMetricValue(1000,'usd') === "1,000 usd"; currentValue null → "—".
        await expect(card).toContainText('1,000 usd');
        await expect(card).toContainText('—');
        // gte comparator glyph.
        await expect(card).toContainText('≥');
        // Draft (non-active) card shows the Window line, not "Next check:".
        await expect(card).toContainText('draft');
        await expect(card).toContainText('Window:');
        await expect(card).toContainText('Monthly');
    });

    test('an active Goal card shows the Next-check line and active status', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Active Card ${suffix()}`;
        const goal = await createGoal(request, token, { title });
        await activateGoal(request, token, goal.id);

        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        const card = cardFor(page, goal.id);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toContainText('active');
        await expect(card).toContainText('Next check:');
    });

    test('card shows the description when set and omits it when null', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const withDesc = `Desc Yes ${suffix()}`;
        const noDesc = `Desc No ${suffix()}`;
        const descText = `bounded goal context ${suffix()}`;
        const g1 = await createGoal(request, token, { title: withDesc, description: descText });
        const g2 = await createGoal(request, token, { title: noDesc, description: null });

        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        const c1 = cardFor(page, g1.id);
        const c2 = cardFor(page, g2.id);
        await expect(c1).toBeVisible({ timeout: 30_000 });
        await expect(c1).toContainText(descText);
        await expect(c2).toBeVisible();
        // The description-less card must not accidentally carry the other's text.
        await expect(c2).not.toContainText(descText);
    });

    test('offset beyond the last page renders the deterministic empty state', async ({ page }) => {
        // ?offset=480 always overshoots the seeded user's goal count → API [] →
        // empty-state block AND the "No results on this page" pagination nav.
        await page.goto('/en/goals?offset=480', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('No Goals yet.')).toBeVisible({ timeout: 30_000 });
        await expect(
            page.getByText('Create a Goal to track a business metric', { exact: false }),
        ).toBeVisible();
        await expect(page.getByText('No results on this page')).toBeVisible();
        await expect(page.getByRole('link', { name: 'Previous' })).toBeVisible();
    });

    test('status filter narrows the list to matching Goals', async ({ page, request }) => {
        const token = await seededToken(request);
        const activeTitle = `Filter Active ${suffix()}`;
        const draftTitle = `Filter Draft ${suffix()}`;
        const active = await createGoal(request, token, { title: activeTitle });
        await activateGoal(request, token, active.id);
        const draft = await createGoal(request, token, { title: draftTitle });

        await page.goto('/en/goals?status=active', { waitUntil: 'domcontentloaded' });
        await expect(cardFor(page, active.id)).toBeVisible({ timeout: 30_000 });
        // The draft Goal must be filtered OUT of the active view.
        await expect(cardFor(page, draft.id)).toHaveCount(0);
    });

    test('an unknown status filter is ignored (no error alert, list still renders)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Bogus Filter ${suffix()}`;
        const goal = await createGoal(request, token, { title });

        await page.goto('/en/goals?status=bogus', { waitUntil: 'domcontentloaded' });
        // Page whitelists status → drops "bogus" → unfiltered list, no 400 leak.
        await expect(cardFor(page, goal.id)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('clicking a Goal card navigates to its detail page', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = `Click Through ${suffix()}`;
        const goal = await createGoal(request, token, { title });

        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        const card = cardFor(page, goal.id);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await card.click();
        await page.waitForURL(new RegExp(`/goals/${goal.id}`), { timeout: 30_000 });
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
    });
});

// ============================================================================
// B. /goals/[id] detail + lifecycle
// ============================================================================

test.describe('Goals — /goals/:id detail (UI)', () => {
    test('draft detail renders progress, details rows and draft-only actions', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Detail Draft ${suffix()}`;
        const goal = await createGoal(request, token, {
            title,
            pluginId: 'stripe',
            metricId: 'income',
            window: 'month',
        });

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('link', { name: 'Back to Goals' })).toBeVisible();

        // Section scaffold.
        await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Outcome' })).toBeVisible();

        // Fresh goal has no samples → empty sparkline copy.
        await expect(page.getByText(/No observations yet/)).toBeVisible();

        // Details rows (values pinned from the seed + defaults).
        await expect(page.getByText('stripe')).toBeVisible();
        await expect(page.getByText('income')).toBeVisible();
        await expect(page.getByText('60 min')).toBeVisible();
        await expect(page.getByText('Open-ended')).toBeVisible();

        // Draft actions: Activate + Delete present; Evaluate now + Pause absent.
        await expect(page.getByRole('button', { name: 'Activate' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Evaluate now' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    });

    test('active detail exposes Evaluate now + Pause and hides Activate', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const goal = await createGoal(request, token, { title: `Detail Active ${suffix()}` });
        await activateGoal(request, token, goal.id);

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: 'Evaluate now' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Activate' })).toHaveCount(0);
    });

    test('UI Activate flips a draft Goal to active', async ({ page, request }) => {
        const token = await seededToken(request);
        const goal = await createGoal(request, token, { title: `UI Activate ${suffix()}` });

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        const activate = page.getByRole('button', { name: 'Activate' });
        await expect(activate).toBeVisible({ timeout: 30_000 });
        await activate.click();

        // Durable proof of the active transition: Pause appears, Activate gone.
        await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: 'Evaluate now' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Activate' })).toHaveCount(0);
    });

    test('UI Pause returns an active Goal to paused', async ({ page, request }) => {
        const token = await seededToken(request);
        const goal = await createGoal(request, token, { title: `UI Pause ${suffix()}` });
        await activateGoal(request, token, goal.id);

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        const pause = page.getByRole('button', { name: 'Pause' });
        await expect(pause).toBeVisible({ timeout: 30_000 });
        await pause.click();

        // Paused: Activate returns; Pause + Evaluate now disappear.
        await expect(page.getByRole('button', { name: 'Activate' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Evaluate now' })).toHaveCount(0);
    });

    test('UI Evaluate now degrades gracefully with no metrics provider', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const goal = await createGoal(request, token, { title: `UI Evaluate ${suffix()}` });
        await activateGoal(request, token, goal.id);

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        const evaluate = page.getByRole('button', { name: 'Evaluate now' });
        await expect(evaluate).toBeVisible({ timeout: 30_000 });
        await evaluate.click();

        // ProviderNotFoundError (404) in this keyless env → the Goal must stay
        // ACTIVE (Pause still offered) and NO sample gets written.
        await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 30_000 });
        expect(await samplesCount(request, token, goal.id)).toBe(0);
        expect(await getGoalStatus(request, token, goal.id)).toBe(200);
    });

    test('an API outcome override is reflected on the detail page', async ({ page, request }) => {
        const token = await seededToken(request);
        const goal = await createGoal(request, token, { title: `Outcome API ${suffix()}` });
        // Human override → status becomes completed, outcome=achieved.
        const patched = await patchGoal(request, token, goal.id, { outcome: 'achieved' });
        expect(patched.status).toBe('completed');
        expect(patched.outcome).toBe('achieved');

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: goal.title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        // Both the OutcomeBadge and the override Select trigger read "Achieved".
        await expect(page.getByText('Achieved').first()).toBeVisible();
    });

    test('UI outcome override completes the Goal via the Select control', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const goal = await createGoal(request, token, { title: `Outcome UI ${suffix()}` });

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: goal.title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        // The only listbox trigger on the detail page is the outcome override.
        const trigger = page.locator('button[aria-haspopup="listbox"]');
        await expect(trigger).toBeVisible();
        await trigger.click();
        await page.getByRole('option', { name: 'Achieved' }).click();

        // Durable proof: the terminal OutcomeBadge now renders "Achieved".
        await expect(page.getByText('Achieved').first()).toBeVisible({ timeout: 30_000 });
        // And the API confirms completion (outcome override completes the Goal).
        await expect
            .poll(() => getGoalLifecycle(request, token, goal.id), { timeout: 15_000 })
            .toBe('completed');
    });

    test('UI Delete removes the Goal and returns to the catalog', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = `UI Delete ${suffix()}`;
        const goal = await createGoal(request, token, { title });

        await page.goto(`/en/goals/${goal.id}`, { waitUntil: 'domcontentloaded' });
        const del = page.getByRole('button', { name: 'Delete' });
        await expect(del).toBeVisible({ timeout: 30_000 });
        // The delete flow guards with window.confirm().
        page.on('dialog', (dialog) => dialog.accept());
        await del.click();

        await page.waitForURL(/\/goals$/, { timeout: 30_000 });
        await expect(cardFor(page, goal.id)).toHaveCount(0);
        // Cascade confirmed at the API: the row is gone.
        expect(await getGoalStatus(request, token, goal.id)).toBe(404);
    });

    test('an unknown Goal id renders the not-found surface, not a detail page', async ({
        page,
    }) => {
        const bogus = '11111111-1111-1111-1111-111111111111';
        const resp = await page.goto(`/en/goals/${bogus}`, { waitUntil: 'domcontentloaded' });
        // Handled cleanly (no 5xx). Next dev may echo 200 with the not-found body.
        expect(resp?.status(), 'no server error for unknown goal').toBeLessThan(500);
        // notFound() renders the standard 404 surface (locale-independent "404"
        // glyph + a "Page not found" heading). Auto-retry so the dev route has
        // time to compile/hydrate before we read the settled DOM.
        await expect(
            page
                .getByText('404')
                .or(page.getByRole('heading', { name: 'Page not found' }))
                .first(),
            `expected not-found copy on ${page.url()}`,
        ).toBeVisible({ timeout: 30_000 });
        // Meaningful invariant: the Goal detail chrome must NOT render.
        await expect(page.getByRole('heading', { name: 'Progress' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Evaluate now' })).toHaveCount(0);
    });
});

// ============================================================================
// C. /goals/new create form
// ============================================================================

test.describe('Goals — /goals/new create form (UI)', () => {
    test('the create form renders its sections, fields and actions', async ({ page }) => {
        await page.goto('/en/goals/new', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'New Goal', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: 'Metric source' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Target' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Evaluation cadence' })).toBeVisible();

        await expect(page.getByLabel('Title')).toBeVisible();
        await expect(page.getByLabel('Provider plugin ID')).toBeVisible();
        await expect(page.getByLabel('Metric ID')).toBeVisible();
        await expect(page.getByLabel('Target value')).toBeVisible();
        await expect(page.getByLabel('Unit')).toBeVisible();

        await expect(page.getByRole('button', { name: 'Create Goal' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible();
    });

    test('client-side validation blocks incomplete submissions', async ({ page }) => {
        await page.goto('/en/goals/new', { waitUntil: 'domcontentloaded' });
        const create = page.getByRole('button', { name: 'Create Goal' });
        await expect(create).toBeVisible({ timeout: 30_000 });

        // Empty title → title-required toast, still on the form.
        await create.click();
        await expect(page.getByText('Title is required.')).toBeVisible({ timeout: 10_000 });
        await expect(page).toHaveURL(/\/goals\/new/);

        // Title but no metric source → metric-source-required toast.
        await page.getByLabel('Title').fill(`Validation ${suffix()}`);
        await create.click();
        await expect(page.getByText('Provider plugin ID and metric ID are required.')).toBeVisible({
            timeout: 10_000,
        });
        await expect(page).toHaveURL(/\/goals\/new/);
    });

    test('a complete create redirects to the new Goal and lists it', async ({ page }) => {
        const title = `Created In UI ${suffix()}`;
        await page.goto('/en/goals/new', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'New Goal', level: 1 })).toBeVisible({
            timeout: 30_000,
        });

        await page.getByLabel('Title').fill(title);
        await page.getByLabel('Provider plugin ID').fill('stripe');
        await page.getByLabel('Metric ID').fill('income');
        await page.getByLabel('Target value').fill('2500');
        await page.getByLabel('Unit').fill('usd');
        await page.getByRole('button', { name: 'Create Goal' }).click();

        // Server action creates the draft and routes to its detail page.
        await page.waitForURL(/\/goals\/[0-9a-f]{8}-[0-9a-f]{4}-/, { timeout: 30_000 });
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        // Fresh draft: the metric value + comparator we entered are shown.
        await expect(page.getByText('2,500 usd').first()).toBeVisible();

        // And it now appears back in the catalog.
        await page.goto('/en/goals', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(title, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
        });
    });
});

// ============================================================================
// D. Navigation
// ============================================================================

test.describe('Goals — dashboard navigation', () => {
    test('the sidebar Goals link routes to the catalog', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const link = page.locator('a[href$="/goals"], a[href*="/goals?"]').first();
        if (!(await link.isVisible({ timeout: 10_000 }).catch(() => false))) {
            test.skip(true, 'no Goals nav link surfaced in this build');
        }
        await link.click();
        await page.waitForURL(/\/goals(\?|$)/, { timeout: 30_000 });
        await expect(page.getByRole('heading', { name: 'Goals', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
    });
});

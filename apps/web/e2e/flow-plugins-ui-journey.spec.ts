import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { getPluginViaAPI, enablePluginViaAPI, disablePluginViaAPI } from './helpers/plugins';

/**
 * Plugins UI journey — /plugins catalog, /plugins/:id detail, and
 * /settings/plugins/:category, driven as the authenticated storageState user.
 *
 * DISTINCT from the existing plugin specs (which this file deliberately does
 * NOT duplicate):
 *   - plugins.spec.ts / plugin-toggle-ui.spec.ts   → status<500 smoke, "a row exists"
 *   - plugin-detail-ui.spec.ts                      → route resolves non-5xx per id/category
 *   - plugin-enable-disable-lifecycle.spec.ts       → notion-extractor toggle on the LIST page
 *   - flow-plugin-lifecycle-search.spec.ts          → API-heavy search/work-scope contracts
 *
 * This file pins the RENDERED catalog surface with hard, observed assertions:
 * exact page header text, category group headings, card badges (Built-in /
 * System), capability tag labels, the search + category-chip + "Enabled only"
 * client filters, the detail page chrome, the settings/category pages, and a
 * full detail-page enable→disable toggle of a keyless plugin (pdf-extractor,
 * distinct from the list-page notion-extractor lifecycle).
 *
 * PROBED LIVE CONTRACT (127.0.0.1:3100 / :3000, sqlite in-memory, flags ON):
 *   GET /api/plugins            → { plugins:[85], total:85, categories:[18], capabilities:[45] }
 *     categories include 'connector','ai-provider','pipeline','notification-channel'
 *     capabilities include 'agent-memory','oauth','search','connector'
 *     each plugin: { id, pluginId, name, version, category, capabilities[],
 *                    enabled:bool, installed:bool, builtIn:bool, systemPlugin:bool,
 *                    visibility, description }
 *   GET /api/plugins?category=X → REDUCED set: only the user's ENABLED/configurable
 *     plugins in X (ai-provider→[openrouter], deployment→[k8s,vercel], git-provider→[github],
 *     search→[tavily], vector-store→[pgvector], pipeline→[agent-pipeline,standard-pipeline],
 *     connector→[] ). This is why /settings/plugins/connector 404s (empty, not 'pipeline')
 *     while /settings/plugins/ai-provider renders. An UNKNOWN category string still 200s (empty).
 *   GET /api/plugins/:id        → 200 for known ids, 404 for unknown (server calls notFound()).
 *   Probed fixtures used below:
 *     openai   → ai-provider, builtIn:true, systemPlugin:false, v1.0.0, caps:['ai-provider']
 *     tavily   → search, systemPlugin:true (no toggle button, "System" badge), caps:['search','content-extractor']
 *     anthropic→ ai-provider, enabled:false by default (hidden under "Enabled only")
 *     pdf-extractor → content-extractor, builtIn, keyless-enable, has readme + settingsSchema{mistralApiKey}
 *     discord-connector / slack-connector → category 'connector'
 *
 * Robustness: fresh registerUserViaAPI() users for API assertions; the seeded
 * storageState user for UI. State-mutating baselines (pdf-extractor, anthropic)
 * are reset via the seeded user's own token so repeat runs are idempotent. IDs
 * asserted via toContain / heading presence, never exact global counts.
 */

const OPENAI = 'openai';
const TAVILY = 'tavily';
const ANTHROPIC = 'anthropic';
const PDF = 'pdf-extractor';

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

/** Raw category-filtered list call (the endpoint listByCategory() drives). */
async function listByCategory(request: APIRequestContext, token: string, category: string) {
    const res = await request.get(
        `${API_BASE}/api/plugins?category=${encodeURIComponent(category)}`,
        {
            headers: authedHeaders(token),
        },
    );
    return { status: res.status(), body: await res.json().catch(() => null) };
}

/**
 * The /plugins card for a plugin display name: anchor on its <h3> heading, then
 * keep the ancestor that also holds the "Settings" link (the card footer).
 */
function pluginCard(page: Page, name: string) {
    return page
        .locator('div', { has: page.getByRole('heading', { level: 3, name, exact: true }) })
        .filter({ has: page.getByRole('link', { name: /Settings/i }) })
        .first();
}

async function openPluginsList(page: Page) {
    await page.goto('/en/plugins', { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible({
        timeout: 30_000,
    });
}

// ---------------------------------------------------------------------------
// API — catalog envelope + reduced category-filter contract (fresh users)
// ---------------------------------------------------------------------------

test.describe('Plugins API — catalog envelope + category-filter contract', () => {
    test('GET /api/plugins returns the {plugins,total,categories,capabilities} envelope', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
            plugins: Array<Record<string, unknown>>;
            total: number;
            categories: string[];
            capabilities: string[];
        };
        expect(Array.isArray(body.plugins)).toBe(true);
        expect(body.plugins.length).toBeGreaterThan(20);
        // total is a real count that matches the array length.
        expect(body.total).toBe(body.plugins.length);

        // The category + capability taxonomies the UI renders as chips/tags.
        expect(body.categories).toEqual(
            expect.arrayContaining(['ai-provider', 'pipeline', 'connector']),
        );
        expect(body.capabilities).toEqual(
            expect.arrayContaining(['ai-provider', 'search', 'agent-memory', 'oauth']),
        );
    });

    test('each plugin row carries the fields the cards render; connectors are present', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/plugins`, {
            headers: authedHeaders(user.access_token),
        });
        const body = (await res.json()) as { plugins: Array<Record<string, unknown>> };
        const byId = new Map(body.plugins.map((p) => [p.id as string, p]));

        for (const id of [OPENAI, TAVILY, PDF, 'discord-connector', 'slack-connector']) {
            const p = byId.get(id);
            expect(p, `plugin "${id}" should be in the catalog`).toBeTruthy();
            expect(typeof p!.name).toBe('string');
            expect(typeof p!.category).toBe('string');
            expect(Array.isArray(p!.capabilities)).toBe(true);
            expect(typeof p!.enabled).toBe('boolean');
            expect(typeof p!.builtIn).toBe('boolean');
            expect(typeof p!.systemPlugin).toBe('boolean');
        }
        // Observed flags the UI keys on.
        expect(byId.get(TAVILY)!.systemPlugin).toBe(true);
        expect(byId.get(OPENAI)!.builtIn).toBe(true);
        expect(byId.get(OPENAI)!.systemPlugin).toBe(false);
        expect(byId.get('discord-connector')!.category).toBe('connector');
        expect(byId.get('slack-connector')!.category).toBe('connector');
    });

    test('category filter returns only configurable rows — connector empty, ai-provider a subset', async ({
        request,
    }) => {
        const user: RegisteredUser = await registerUserViaAPI(request);

        // The FULL list has connector plugins, but the settings-menu-scoped
        // category filter returns NONE for a fresh user (nothing enabled) — this
        // is exactly why /settings/plugins/connector 404s while the /plugins
        // list still shows a "Connectors" group.
        const connectors = await listByCategory(request, user.access_token, 'connector');
        expect(connectors.status).toBe(200);
        expect((connectors.body as { plugins: unknown[] }).plugins.length).toBe(0);

        // ai-provider filter → non-empty subset, every row is category ai-provider
        // and enabled (openrouter is the default gateway for a fresh user).
        const ai = await listByCategory(request, user.access_token, 'ai-provider');
        expect(ai.status).toBe(200);
        const aiPlugins = (ai.body as { plugins: Array<{ category: string; enabled: boolean }> })
            .plugins;
        expect(aiPlugins.length).toBeGreaterThan(0);
        for (const p of aiPlugins) {
            expect(p.category).toBe('ai-provider');
            expect(p.enabled).toBe(true);
        }

        // An UNKNOWN category string does not 500 — it 200s with an empty set.
        const bogus = await listByCategory(request, user.access_token, 'not-a-real-category-xyz');
        expect(bogus.status).toBe(200);
        expect((bogus.body as { plugins: unknown[] }).plugins.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// UI — /plugins catalog list
// ---------------------------------------------------------------------------

test.describe('Plugins UI — catalog list rendering', () => {
    test('page header renders the title + subtitle and is not auth-gated', async ({ page }) => {
        await openPluginsList(page);
        await expect(page.getByText('Manage your installed plugins and integrations')).toBeVisible({
            timeout: 15_000,
        });
    });

    test('search bar, "All" chip and "Enabled only" toggle all render', async ({ page }) => {
        await openPluginsList(page);
        await expect(page.getByPlaceholder('Search plugins...')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
        await expect(page.getByRole('checkbox')).toBeVisible();
        await expect(page.getByText('Enabled only')).toBeVisible();
    });

    test('grouped view shows category section headings (AI Providers, Pipeline, Connectors)', async ({
        page,
    }) => {
        await openPluginsList(page);
        // The default (unsearched, unfiltered) view groups cards under h2 labels
        // resolved by getCategoryLabel(). These three are always present because
        // the catalog always contains ai-provider / pipeline / connector plugins.
        for (const label of ['AI Providers', 'Pipeline', 'Connectors']) {
            await expect(
                page.getByRole('heading', { level: 2, name: label, exact: true }),
            ).toBeVisible({ timeout: 20_000 });
        }
    });

    test('OpenAI card: name, version, Built-in badge, Settings link, toggle button', async ({
        page,
    }) => {
        await openPluginsList(page);
        // Filter to a single card to remove ambiguity/virtualization.
        await page.getByPlaceholder('Search plugins...').fill('OpenAI');

        const card = pluginCard(page, 'OpenAI');
        await expect(card).toBeVisible({ timeout: 20_000 });
        await expect(card.getByText(/^v1\.0\.0/)).toBeVisible();
        await expect(card.getByText('Built-in')).toBeVisible();
        // Settings link points at the detail route for this plugin id.
        await expect(card.getByRole('link', { name: /Settings/i })).toHaveAttribute(
            'href',
            /\/plugins\/openai$/,
        );
        // openai is not a system plugin → it exposes an Enable/Disable toggle.
        await expect(card.getByRole('button', { name: /^(Enable|Disable)$/ })).toBeVisible();
        // Category tag on the card — a <span> (getCategoryLabel('ai-provider')).
        // Scope to the span so it doesn't collide with the identically-labelled
        // "AI Providers" category-filter <button> that the broad card ancestor
        // locator also encloses.
        await expect(card.locator('span', { hasText: 'AI Providers' }).first()).toBeVisible();
    });

    test('Tavily is a system plugin — "System" badge, a capability tag, NO toggle button', async ({
        page,
    }) => {
        await openPluginsList(page);
        await page.getByPlaceholder('Search plugins...').fill('Tavily');

        const card = pluginCard(page, 'Tavily');
        await expect(card).toBeVisible({ timeout: 20_000 });
        // System plugins render the marker as "<middot> System" inside the
        // version line (`<span class="text-primary">&middot; System</span>`),
        // so an exact 'System' match never lands — assert the substring and
        // take .first() to ride over the nested version <p>/<span> elements.
        await expect(card.getByText('System').first()).toBeVisible();
        // caps ['search','content-extractor'] minus the 'search' category →
        // the "Content Processor" capability tag renders (it can appear as both
        // the category label and a capability chip, so take .first()).
        await expect(card.getByText('Content Processor').first()).toBeVisible();
        // System plugins cannot be toggled off — no Enable/Disable button.
        await expect(card.getByRole('button', { name: /^(Enable|Disable)$/ })).toHaveCount(0);
    });
});

// ---------------------------------------------------------------------------
// UI — client-side search / category / enabled-only filtering
// ---------------------------------------------------------------------------

test.describe('Plugins UI — search & filter interactions', () => {
    test('typing a query switches to a flat, filtered grid', async ({ page }) => {
        await openPluginsList(page);
        // "Vercel" is visible in the unsearched view.
        await expect(
            page.getByRole('heading', { level: 3, name: 'Vercel', exact: true }),
        ).toBeVisible({
            timeout: 20_000,
        });

        await page.getByPlaceholder('Search plugins...').fill('openai');
        await expect(
            page.getByRole('heading', { level: 3, name: 'OpenAI', exact: true }),
        ).toBeVisible({ timeout: 15_000 });
        // The category group heading disappears in flat/search mode and the
        // unrelated Vercel card is filtered out.
        await expect(
            page.getByRole('heading', { level: 3, name: 'Vercel', exact: true }),
        ).toHaveCount(0);
    });

    test('clearing the search via the X button restores the full grouped list', async ({
        page,
    }) => {
        await openPluginsList(page);
        const search = page.getByPlaceholder('Search plugins...');
        await search.fill('openai');
        await expect(
            page.getByRole('heading', { level: 3, name: 'Vercel', exact: true }),
        ).toHaveCount(0);

        await page.getByRole('button', { name: 'Clear search' }).click();
        await expect(search).toHaveValue('');
        // Grouped view is back → the group headings and Vercel card return.
        await expect(
            page.getByRole('heading', { level: 2, name: 'Deployment', exact: true }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
            page.getByRole('heading', { level: 3, name: 'Vercel', exact: true }),
        ).toBeVisible();
    });

    test('a no-match query shows the empty state with the exact query text', async ({ page }) => {
        await openPluginsList(page);
        const nonce = `zznope-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await page.getByPlaceholder('Search plugins...').fill(nonce);

        await expect(page.getByText(`No plugins match "${nonce}"`)).toBeVisible({
            timeout: 15_000,
        });
        // The empty state offers a clear-search affordance that restores results.
        // Two controls share the accessible name "Clear search" (the search-bar
        // X uses aria-label; the empty-state control is a real text button), so
        // target the text button by its exact visible text.
        await page.getByText('Clear search', { exact: true }).click();
        await expect(page.getByText(`No plugins match "${nonce}"`)).toHaveCount(0);
        await expect(
            page.getByRole('heading', { level: 3, name: 'OpenAI', exact: true }),
        ).toBeVisible({ timeout: 15_000 });
    });

    test('the "Connectors" category chip filters the grid to connector plugins', async ({
        page,
    }) => {
        await openPluginsList(page);
        await page.getByRole('button', { name: 'Connectors', exact: true }).click();

        // Connector plugins surface; the AI-provider OpenAI card is filtered out.
        await expect(
            page.getByRole('heading', { level: 3, name: 'Discord Connector', exact: true }),
        ).toBeVisible({ timeout: 20_000 });
        await expect(
            page.getByRole('heading', { level: 3, name: 'Slack Connector', exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { level: 3, name: 'OpenAI', exact: true }),
        ).toHaveCount(0);
    });

    test('"Enabled only" hides disabled plugins while keeping enabled ones', async ({
        page,
        request,
    }) => {
        // Deterministic baseline: force Anthropic disabled for the seeded user.
        const token = await seededToken(request);
        await disablePluginViaAPI(request, token, ANTHROPIC).catch(() => undefined);
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, ANTHROPIC)).enabled, {
                timeout: 15_000,
            })
            .toBe(false);

        await openPluginsList(page);
        // Before filtering, the disabled Anthropic card is present.
        await expect(
            page.getByRole('heading', { level: 3, name: 'Anthropic', exact: true }),
        ).toBeVisible({ timeout: 20_000 });

        await page.getByRole('checkbox').check();

        // Anthropic (disabled) drops out; Tavily (system → always enabled) stays.
        await expect(
            page.getByRole('heading', { level: 3, name: 'Anthropic', exact: true }),
        ).toHaveCount(0, { timeout: 15_000 });
        await expect(
            page.getByRole('heading', { level: 3, name: 'Tavily', exact: true }),
        ).toBeVisible();
    });
});

// ---------------------------------------------------------------------------
// UI — /plugins/:id detail page
// ---------------------------------------------------------------------------

test.describe('Plugins UI — detail page', () => {
    test('OpenAI detail: title, version, Built-in badge, category footer, Back link, toggle', async ({
        page,
    }) => {
        await page.goto('/en/plugins/openai', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1, name: 'OpenAI' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('v1.0.0', { exact: true })).toBeVisible();
        await expect(page.getByText('Built-in', { exact: true })).toBeVisible();
        // Metadata footer renders the human category label.
        await expect(page.getByText('AI Providers', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: /Back to Plugins/i })).toBeVisible();
        // Not a system plugin → a header toggle is present.
        await expect(page.getByRole('button', { name: /^(Enable|Disable)$/ })).toBeVisible();
    });

    test('pdf-extractor detail renders the Plugin Settings panel and the About/readme section', async ({
        page,
    }) => {
        await page.goto('/en/plugins/pdf-extractor', { waitUntil: 'domcontentloaded' });
        await expect(
            page.getByRole('heading', { level: 1, name: 'PDF Content Extractor' }),
        ).toBeVisible({ timeout: 30_000 });
        // It ships a settingsSchema (mistralApiKey) → the "Plugin Settings" card.
        await expect(page.getByRole('heading', { name: 'Plugin Settings' })).toBeVisible({
            timeout: 15_000,
        });
        // It ships a readme → the "About" section renders its markdown.
        await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible();
        await expect(page.getByText(/PDF Content Processor/i).first()).toBeVisible();
    });

    test('Tavily detail: system plugin → "System" badge + capability badge, no toggle', async ({
        page,
    }) => {
        await page.goto('/en/plugins/tavily', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1, name: 'Tavily' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByText('System', { exact: true })).toBeVisible();
        // caps minus the 'search' category → the "Content Processor" badge.
        await expect(page.getByText('Content Processor').first()).toBeVisible();
        // System plugins expose no enable/disable control on the detail header.
        await expect(page.getByRole('button', { name: /^(Enable|Disable)$/ })).toHaveCount(0);
    });

    test('unknown plugin id 404s (server notFound), never 5xx', async ({ page }) => {
        const res = await page.goto(`/en/plugins/does-not-exist-${Date.now().toString(36)}`, {
            waitUntil: 'domcontentloaded',
        });
        expect(res, 'goto should return a response').toBeTruthy();
        expect(res!.status()).toBe(404);
    });

    test('the "Back to Plugins" link returns to the catalog list', async ({ page }) => {
        await page.goto('/en/plugins/openai', { waitUntil: 'domcontentloaded' });
        const back = page.getByRole('link', { name: /Back to Plugins/i });
        await expect(back).toBeVisible({ timeout: 30_000 });
        await back.click();
        // The back control is a next-intl <Link> → client-side (soft) nav, which
        // never fires a document 'load' event, so waitForURL's default
        // waitUntil:'load' hangs. Poll the URL instead; then wait out the
        // first-hit /plugins compile for the catalog heading.
        await expect(page).toHaveURL(/\/plugins(\/)?$/, { timeout: 30_000 });
        await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible({
            timeout: 30_000,
        });
    });
});

// ---------------------------------------------------------------------------
// UI — /settings/plugins/:category
// ---------------------------------------------------------------------------

test.describe('Plugins UI — settings category pages', () => {
    test('bare /settings/plugins redirects to the ai-provider category and renders it', async ({
        page,
    }) => {
        await page.goto('/en/settings/plugins', { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/settings\/plugins\/ai-provider/, { timeout: 20_000 });
        await expect(page.getByRole('heading', { name: 'AI Providers', exact: true })).toBeVisible({
            timeout: 30_000,
        });
        // The single configurable AI provider (OpenRouter, default gateway).
        // Its inline-SVG icon carries a hidden <title>OpenRouter</title> that
        // precedes the visible name in the DOM, so getByText(...).first() would
        // resolve to that hidden <title>. Target the visible name <span>, which
        // carries a title="OpenRouter" attribute (plugin.name).
        await expect(page.locator('span[title="OpenRouter"]')).toBeVisible({
            timeout: 15_000,
        });
    });

    test('deployment category renders its label and an expandable plugin card', async ({
        page,
    }) => {
        await page.goto('/en/settings/plugins/deployment', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Deployment', exact: true })).toBeVisible({
            timeout: 30_000,
        });
        // Two configurable deployment plugins render as collapsible cards.
        const vercel = page.getByText('Vercel', { exact: true }).first();
        const k8s = page.getByText('Kubernetes', { exact: true }).first();
        // Both cards render, so the combined .or() matches 2 elements — add a
        // trailing .first() to keep the single-element visibility assertion.
        await expect(vercel.or(k8s).first()).toBeVisible({ timeout: 15_000 });
    });

    test('pipeline category renders (special-cased) with its label + a pipeline plugin', async ({
        page,
    }) => {
        await page.goto('/en/settings/plugins/pipeline', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Pipeline', exact: true })).toBeVisible({
            timeout: 30_000,
        });
        const standard = page.getByText('Standard Pipeline', { exact: true }).first();
        const agent = page.getByText('Agent Pipeline', { exact: true }).first();
        // Both pipelines render, so the combined .or() matches 2 elements — add a
        // trailing .first() to keep the single-element visibility assertion.
        await expect(standard.or(agent).first()).toBeVisible({ timeout: 15_000 });
    });

    test('an invalid category 404s; the empty connector category also 404s (never 5xx)', async ({
        page,
    }) => {
        const invalid = await page.goto('/en/settings/plugins/not-a-real-category-xyz', {
            waitUntil: 'domcontentloaded',
        });
        expect(invalid!.status()).toBe(404);

        // connector is a valid category but has 0 configurable plugins for a
        // default user → `category !== 'pipeline' && plugins.length === 0`
        // makes the page call notFound(). Tolerate 200 if a connector happens
        // to be enabled in the shared DB; only 5xx is a real failure.
        const conn = await page.goto('/en/settings/plugins/connector', {
            waitUntil: 'domcontentloaded',
        });
        expect(conn!.status()).toBeLessThan(500);
        expect([200, 404]).toContain(conn!.status());
    });
});

// ---------------------------------------------------------------------------
// UI + API — safe plugin enable→disable toggle from the DETAIL page
// ---------------------------------------------------------------------------

test.describe('Plugins UI — detail-page enable/disable toggle (pdf-extractor)', () => {
    // Both tests mutate the SAME seeded-user plugin (pdf-extractor); serialize
    // so they can't race each other on the shared in-memory DB state.
    test.describe.configure({ mode: 'serial' });

    test('detail toggle enables then disables a keyless plugin and persists via the API', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);

        // Idempotent baseline: DISABLED before we drive the UI.
        await disablePluginViaAPI(request, token, PDF).catch(() => undefined);
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, PDF)).enabled, {
                timeout: 15_000,
            })
            .toBe(false);

        await page.goto('/en/plugins/pdf-extractor', { waitUntil: 'domcontentloaded' });
        await expect(
            page.getByRole('heading', { level: 1, name: 'PDF Content Extractor' }),
        ).toBeVisible({ timeout: 30_000 });

        // Baseline: header offers "Enable".
        const enableBtn = page.getByRole('button', { name: /^Enable$/ });
        await expect(enableBtn).toBeVisible({ timeout: 15_000 });

        // --- ENABLE ------------------------------------------------------
        // visibility:'public' → clicking Enable opens the PluginEnablePanel
        // dialog (title "Enable"); confirm with its footer "Enable" button.
        // Retry the open click to ride out the dev/prod hydration race.
        await expect(async () => {
            await enableBtn.click();
            await expect(
                page.getByRole('dialog').getByRole('button', { name: /^Enable$/ }),
            ).toBeVisible({ timeout: 4_000 });
        }).toPass({ timeout: 30_000 });
        await page
            .getByRole('dialog')
            .getByRole('button', { name: /^Enable$/ })
            .click();

        // Optimistic flip to "Disable".
        await expect(page.getByRole('button', { name: /^Disable$/ })).toBeVisible({
            timeout: 20_000,
        });
        // Persisted server-side.
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, PDF)).enabled, {
                timeout: 15_000,
                message: 'UI enable should persist as enabled:true',
            })
            .toBe(true);

        // --- DISABLE -----------------------------------------------------
        // Clicking Disable opens the PluginDisableWarning dialog; confirm with
        // "Confirm Disable".
        await expect(async () => {
            await page.getByRole('button', { name: /^Disable$/ }).click();
            await expect(
                page.getByRole('dialog').getByRole('button', { name: /Confirm Disable/i }),
            ).toBeVisible({ timeout: 4_000 });
        }).toPass({ timeout: 30_000 });
        await page
            .getByRole('dialog')
            .getByRole('button', { name: /Confirm Disable/i })
            .click();

        // Optimistic flip back to "Enable".
        await expect(page.getByRole('button', { name: /^Enable$/ })).toBeVisible({
            timeout: 20_000,
        });
        // Persisted server-side.
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, PDF)).enabled, {
                timeout: 15_000,
                message: 'UI disable should persist as enabled:false',
            })
            .toBe(false);
    });

    test('enabling pdf-extractor via the API is reflected as "Enabled" on its detail toggle', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        // Drive state from the API, then assert the UI reads the same per-user state.
        await enablePluginViaAPI(request, token, PDF, { autoEnableForWorks: false });
        await expect
            .poll(async () => (await getPluginViaAPI(request, token, PDF)).enabled, {
                timeout: 15_000,
            })
            .toBe(true);

        await page.goto('/en/plugins/pdf-extractor', { waitUntil: 'domcontentloaded' });
        await expect(
            page.getByRole('heading', { level: 1, name: 'PDF Content Extractor' }),
        ).toBeVisible({ timeout: 30_000 });
        // Enabled → the header toggle offers "Disable".
        await expect(page.getByRole('button', { name: /^Disable$/ })).toBeVisible({
            timeout: 20_000,
        });

        // Cleanup: return to a disabled baseline for sibling specs.
        await disablePluginViaAPI(request, token, PDF).catch(() => undefined);
    });
});

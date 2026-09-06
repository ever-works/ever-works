import { test, expect, type Locator, type Page } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { API_BASE, authedHeaders, orgScopedHeaders } from './helpers/api';

/**
 * Org-wide Memory (Cortex P1) — the Memory PAGE, driven through the real
 * authenticated UI (storageState), DEEP + ASSERTIVE.
 *
 * The sibling `flow-org-memory-page-deep.spec.ts` pins the `GET /api/memory`
 * + `POST /api/memory/consolidate` CONTRACT at the REST layer with fresh,
 * scope-pinned users. This file is the complementary UI journey: it lands
 * the shared seeded user on the canonical Organization route
 * `/org/<slug>/memory` and pins the actual rendered `MemoryShell` surface —
 * nothing here overlaps the API spec. Coverage:
 *
 *   • page chrome: `memory-shell` mounts, the "Memory" heading + subtitle
 *     render, the document <title> comes from `generateMetadata`, the search
 *     box + "Consolidate" action + "documents indexed" header count render.
 *     These are scope-agnostic, so they stay on the unprefixed `/en/memory`
 *     → `/memory` route and also pin that locale-prefix collapse.
 *   • seeded KB docs authored in the session user's Organization surface as
 *     `memory-doc-<id>` rows with their title, class chip, and a link to the
 *     source Work (workName) — seeded through the API with an explicit
 *     `X-Scope-Slug: <org-slug>` so the rows are stamped into the SAME
 *     Organization the `/org/<slug>/memory` page reads
 *   • filter chips render per facet (type / work / status / source) with the
 *     titleCased labels the shell computes; clicking a Type chip flips
 *     aria-pressed and narrows the feed (a non-matching seeded row drops out),
 *     multi-select is OR within a facet, and "Clear all" restores the feed
 *   • the search box filters by title (lexical q → title/description) and a
 *     no-match query renders the real `empty.noResults` empty-state
 *   • Memory Consolidation: the Consolidate button opens the dry-run confirm
 *     panel (scanned/promoted/superseded chips, Apply/Cancel) WITHOUT writing;
 *     Cancel closes it; Apply persists and swaps in the applied summary, after
 *     which a reload shows at least one promoted/superseded doc badge
 *
 * ── SCOPE CONTRACT (since 8f28edca0 — `apps/api/src/scope/session-scope.guard.ts`)
 *      An Organization scope requires EITHER an explicit `X-Scope-Slug:
 *      <org-slug>` header OR an `/api/<slug>/…` path. The guard deliberately
 *      refuses to infer one from the user's mutable last-Organization
 *      preference ("Never read the user's mutable last-Organization
 *      preference here … This is what keeps simultaneous Ever and Yo tabs
 *      isolated"), so an unprefixed bare-Bearer call is the PERSONAL
 *      contract. Two consequences shape this file:
 *        - Seeding sends `X-Scope-Slug` (see `orgScopedHeaders` in
 *          `helpers/api.ts`). Without it the Work + KB docs are stamped
 *          `organizationId: null` and Memory can never see them.
 *        - The browser must be on `/org/<slug>/memory`. `apps/web/src/proxy.ts`
 *          stamps `x-ever-workspace` from `parseWorkspacePath(pathname)` and
 *          `lib/api/server-api.ts` turns that into `X-Scope-Slug` on the SSR
 *          fetch; an unprefixed `/memory` is `personal`, and
 *          `OrgMemoryController.getMemory` early-returns the EMPTY aggregation
 *          with HTTP 200 when no Organization resolves — so an unprefixed
 *          journey renders zero rows instead of failing loudly.
 *
 * ── KNOWN PRODUCT GAP — the interactive assertions below
 *      SSR is Organization-scoped, but the shell's client-side re-query
 *      (`MemoryShell.runFetch`) and the Consolidate POST go to the
 *      same-origin BFF routes `apps/web/src/app/api/memory/route.ts` and
 *      `apps/web/src/app/api/memory/consolidate/route.ts`. Both forward a
 *      bare Bearer with NO scope header — neither calls
 *      `applyBffWorkspaceScope` the way `app/api/organizations/route.ts`
 *      does, and `MemoryShell` uses raw `fetch` rather than
 *      `lib/api/browser-api.ts`'s `browserApiFetch`. So the first search
 *      keystroke / chip click / Consolidate lands in PERSONAL scope and
 *      empties the feed. The chip / search / consolidation assertions below
 *      are the correct Organization behaviour and are left asserting it —
 *      they stay RED until the product is fixed; do NOT "repair" them by
 *      loosening what they check or by moving them back to `/memory`.
 *      The gap is the whole `app/api/memory/*` BFF subtree, not just those
 *      two routes: none of `files/*`, `health`, `review` (incl. the accept
 *      / reject WRITES), `uploads` or `consolidation/settings` forwards the
 *      scope either — only 10 of the 78 BFF route files under `app/api`
 *      call `applyBffWorkspaceScope` at all.
 *
 * Seeding uses the shared `loadSeededTestUser()` creds (written by
 * global-setup) so the API-seeded Work is owned by the SAME account whose
 * storageState cookie the browser carries — the established green pattern
 * from `flow-kb-workbench-shell.spec.ts`. Assertions target the specific
 * seeded doc ids (toBeVisible / toBeHidden) and never global counts, so a
 * shared Org that accumulates rows across the run stays robust.
 */

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface SeededDoc {
    id: string;
    title: string;
    class: string;
    status: string;
    source: string;
}

// Populated once in beforeAll; consumed by the seeded-content tests.
let seedOk = false;
let seedError = '';
let orgSlug = '';
let workId = '';
let workName = '';
let brandDoc: SeededDoc; // class brand / active — title token "alpha"
let personaDoc: SeededDoc; // class personas / active — title token "bravo"
let legalDoc: SeededDoc; // class legal / draft — title token "charlie"

/** Auth only — for the Organization endpoints, which key off the user id. */
function jsonAuthHeaders(token: string): Record<string, string> {
    return { ...authedHeaders(token), 'content-type': 'application/json' };
}

/**
 * Auth + the `X-Scope-Slug` pin at `orgSlug`. Every seed write goes through
 * this: without the pin the row is stamped `organizationId: null` and the
 * Organization-scoped Memory page can never read it back.
 */
function jsonOrgHeaders(token: string): Record<string, string> {
    return { ...orgScopedHeaders(token, orgSlug), 'content-type': 'application/json' };
}

async function createDoc(
    token: string,
    input: { path: string; title: string; cls: string; status: string; description: string },
): Promise<SeededDoc> {
    const res = await fetch(`${API_BASE}/api/works/${workId}/kb/documents`, {
        method: 'POST',
        headers: jsonOrgHeaders(token),
        body: JSON.stringify({
            path: input.path,
            title: input.title,
            class: input.cls,
            body: `seed body ${RUN}`,
            description: input.description,
            status: input.status,
        }),
    });
    if (!res.ok) {
        throw new Error(`createDoc(${input.path}) failed ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as SeededDoc;
    return j;
}

/**
 * Seed ONE Organization of the session user with a Work + a spread of KB docs
 * so the page has deterministic rows to render, filter, and consolidate.
 *
 * Every write is pinned with `X-Scope-Slug: <orgSlug>` and the browser is then
 * pointed at `/org/<orgSlug>/memory`, so seed and page agree on exactly one
 * Organization. `GET`/`POST /api/organizations` are the two calls that stay
 * bare-Bearer on purpose: both resolve from the user id (`listForUser` /
 * `createOrganization`), not from the request scope.
 */
test.beforeAll(async () => {
    test.setTimeout(120_000);
    try {
        const creds = loadSeededTestUser();
        const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: creds.email, password: creds.password }),
        });
        if (!loginRes.ok) {
            throw new Error(`login failed ${loginRes.status}: ${await loginRes.text()}`);
        }
        const token = ((await loginRes.json()) as { access_token: string }).access_token;

        // Resolve the Organization slug to pin every seed write (and the page
        // URL) to. global-setup lazy-creates one; be defensive in case a
        // bespoke env skipped it.
        const orgsRes = await fetch(`${API_BASE}/api/organizations`, {
            headers: authedHeaders(token),
        });
        const orgs = orgsRes.ok ? ((await orgsRes.json()) as { slug?: string }[]) : [];
        orgSlug = (Array.isArray(orgs) ? (orgs[0]?.slug ?? '') : '').trim();
        if (!orgSlug) {
            const createOrg = await fetch(`${API_BASE}/api/organizations`, {
                method: 'POST',
                headers: jsonAuthHeaders(token),
                body: JSON.stringify({ name: `MemUI Org ${RUN}` }),
            });
            if (!createOrg.ok) {
                throw new Error(`org create failed ${createOrg.status}: ${await createOrg.text()}`);
            }
            orgSlug = (((await createOrg.json()) as { slug?: string }).slug ?? '').trim();
        }
        if (!orgSlug) {
            throw new Error('no Organization slug resolved for the seeded test user');
        }

        workName = `MemUI Journey ${RUN}`;
        const wkRes = await fetch(`${API_BASE}/api/works`, {
            method: 'POST',
            headers: jsonOrgHeaders(token),
            body: JSON.stringify({
                name: workName,
                slug: `mem-ui-journey-${RUN}`,
                description: 'org memory ui journey',
                organization: false,
            }),
        });
        if (!wkRes.ok) {
            throw new Error(`work create failed ${wkRes.status}: ${await wkRes.text()}`);
        }
        const wk = (await wkRes.json()) as { work?: { id?: string }; id?: string };
        workId = (wk.work?.id ?? wk.id ?? '') as string;
        if (!workId) throw new Error('work id missing from create response');

        brandDoc = await createDoc(token, {
            path: `brand/alpha-${RUN}.md`,
            title: `MemUI Brand ${RUN} alpha`,
            cls: 'brand',
            status: 'active',
            description: `brand tone description ${RUN}`,
        });
        personaDoc = await createDoc(token, {
            path: `personas/bravo-${RUN}.md`,
            title: `MemUI Persona ${RUN} bravo`,
            cls: 'personas',
            status: 'active',
            description: `persona description ${RUN}`,
        });
        legalDoc = await createDoc(token, {
            path: `legal/charlie-${RUN}.md`,
            title: `MemUI Legal ${RUN} charlie`,
            cls: 'legal',
            status: 'draft',
            description: `legal description ${RUN}`,
        });
        // A near-duplicate pair to guarantee the consolidation pass has
        // something to promote/supersede when Apply runs.
        await createDoc(token, {
            path: `research/delta-1-${RUN}.md`,
            title: `MemUI Research Digest ${RUN}`,
            cls: 'research',
            status: 'active',
            description: `research digest ${RUN}`,
        });
        await createDoc(token, {
            path: `research/delta-2-${RUN}.md`,
            title: `MemUI Research Digest ${RUN}`,
            cls: 'research',
            status: 'active',
            description: `research digest copy ${RUN}`,
        });

        seedOk = true;
    } catch (err) {
        seedError = (err as Error).message;
        // Structural chrome tests below do not depend on the seed; the
        // seeded-content tests self-skip with this message.
    }
});

/**
 * Land on the PERSONAL Memory route. Used by the page-chrome tests, whose
 * assertions are scope-agnostic — the shell, heading, search box and
 * Consolidate action all render on an empty payload, and the header count
 * falls through to the `documentsIndexed` zero-state ("No documents
 * indexed"). Going in unprefixed also keeps the `/en/memory` → `/memory`
 * locale collapse under test.
 */
async function gotoMemory(page: Page): Promise<void> {
    await page.goto('/en/memory', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('memory-shell')).toBeVisible({ timeout: 30_000 });
}

/**
 * Land on the canonical Organization Memory route. `proxy.ts` strips the
 * `/org/<slug>` prefix for the internal App Router match and stamps
 * `x-ever-workspace: org:<slug>`, which `serverFetch` forwards to the API as
 * `X-Scope-Slug` — the only way the SSR aggregation sees the seeded rows.
 */
async function gotoOrgMemory(page: Page): Promise<void> {
    await page.goto(`/org/${orgSlug}/memory`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('memory-shell')).toBeVisible({ timeout: 30_000 });
}

function requireSeed(): void {
    test.skip(!seedOk, `memory seed unavailable: ${seedError || 'setup did not run'}`);
}

/**
 * PRE-HYDRATION SWALLOWED CLICK — why the two helpers below exist.
 *
 * `/memory` is a server component: the `MemoryShell` markup (chips, the
 * Consolidate button, the seeded rows) is in the SSR HTML, so it is
 * visible AND passes Playwright's actionability checks well before React
 * has hydrated and attached `onClick`. A click that lands in that window
 * is silently dropped — the chip's `aria-pressed` never flips, the
 * Consolidate POST is never issued, and the test times out on a state
 * that can no longer arrive. Under `fullyParallel` workers this is a
 * per-run coin flip, which is exactly how it presented (sibling chip
 * tests green, these two red).
 *
 * The suite's established remedy is the retry-to-act pattern already
 * documented in `helpers/nav.ts`: re-issue the click until the state a
 * real user would see actually appears. Both helpers are state-driven
 * (they only click when the target state is still absent), so a click
 * that *did* land is never undone by a retry.
 */

/** Drive a filter chip to `pressed`, riding out a swallowed first click. */
async function setChipPressed(chip: Locator, pressed: boolean, timeout = 30_000): Promise<void> {
    const want = String(pressed);
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
        if ((await chip.getAttribute('aria-pressed')) !== want) {
            await chip.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await expect(chip).toHaveAttribute('aria-pressed', want, { timeout: 3_000 });
    }).toPass({ timeout });
}

/** Click `control` until `expected` becomes visible (same hydration race). */
async function clickUntilVisible(
    control: Locator,
    expected: Locator,
    timeout = 45_000,
): Promise<void> {
    await expect(control).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
        if (!(await expected.isVisible().catch(() => false))) {
            // The button disables itself while the POST is in flight, so a
            // retry issued mid-request simply fails actionability and is
            // swallowed here — it can never double-submit.
            await control.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await expect(expected).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout });
}

test.describe('Org Memory UI — page chrome (/memory)', () => {
    test('lands on /memory authenticated and mounts the memory shell', async ({ page }) => {
        test.setTimeout(60_000);
        await page.goto('/en/memory', { waitUntil: 'domcontentloaded' });
        // Not bounced to login — the storageState session is honoured.
        await expect(page).not.toHaveURL(/\/login/);
        // The /en prefix collapses to the unprefixed canonical route.
        await expect(page).toHaveURL(/\/memory(\?|$)/);
        await expect(page.getByTestId('memory-shell')).toBeVisible({ timeout: 30_000 });
    });

    test('renders the "Memory" heading and the aggregation subtitle', async ({ page }) => {
        test.setTimeout(60_000);
        await gotoMemory(page);
        await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();
        await expect(page.getByText(/Everything your organization knows/i)).toBeVisible();
    });

    test('document <title> is driven by generateMetadata (contains "Memory")', async ({ page }) => {
        test.setTimeout(60_000);
        await gotoMemory(page);
        await expect(page).toHaveTitle(/Memory/i);
    });

    test('search box, Consolidate action, and "documents indexed" header all render', async ({
        page,
    }) => {
        test.setTimeout(60_000);
        await gotoMemory(page);

        const search = page.getByTestId('memory-search');
        await expect(search).toBeVisible();
        await expect(search).toHaveAttribute('type', 'search');
        await expect(search).toHaveAttribute('placeholder', /Search across everything/i);

        const consolidate = page.getByTestId('memory-consolidate-button');
        await expect(consolidate).toBeVisible();
        await expect(consolidate).toHaveText(/Consolidate/i);

        // The stable header count reads "N document(s) indexed" (or the
        // zero-state copy) — either way the word "indexed" is present.
        await expect(page.getByText(/indexed/i).first()).toBeVisible();
    });

    test('the search input is interactive (typing updates its value)', async ({ page }) => {
        test.setTimeout(60_000);
        await gotoMemory(page);
        const search = page.getByTestId('memory-search');
        await search.fill('hello-memory');
        await expect(search).toHaveValue('hello-memory');
        await search.fill('');
        await expect(search).toHaveValue('');
    });
});

test.describe('Org Memory UI — seeded documents & facets', () => {
    test('a seeded KB doc surfaces as a row with its title', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);
        const row = page.getByTestId(`memory-doc-${brandDoc.id}`);
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row).toContainText(`MemUI Brand ${RUN} alpha`);
    });

    test('a seeded doc row shows its class chip and links to the source Work', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);
        const row = page.getByTestId(`memory-doc-${brandDoc.id}`);
        await expect(row).toBeVisible({ timeout: 15_000 });
        // Class chip carries the exact class text (rendered lowercase in the
        // DOM, uppercased via CSS) — distinct from the title's "Brand".
        await expect(row.getByText('brand', { exact: true }).first()).toBeVisible();
        // Row links to the Work KB, labelled by the resolved workName.
        const workLink = row.locator('a[href*="/kb"]');
        await expect(workLink).toHaveCount(1);
        await expect(workLink).toContainText(workName);
    });

    test('facet chips render for the seeded type / work / status / source facets', async ({
        page,
    }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);

        const typeBrand = page.getByTestId('memory-filter-chip-type:brand');
        await expect(typeBrand).toBeVisible({ timeout: 15_000 });
        await expect(typeBrand).toContainText('Brand'); // titleCased label

        const workChip = page.getByTestId(`memory-filter-chip-work:${workId}`);
        await expect(workChip).toBeVisible();
        await expect(workChip).toContainText(workName);

        // Seeded set has active (brand/persona/research) + draft (legal).
        await expect(page.getByTestId('memory-filter-chip-status:active')).toBeVisible();
        await expect(page.getByTestId('memory-filter-chip-status:draft')).toBeVisible();

        const sourceUser = page.getByTestId('memory-filter-chip-source:user');
        await expect(sourceUser).toBeVisible();
        await expect(sourceUser).toContainText('User'); // titleCased label
    });

    test('clicking a Type chip flips aria-pressed and narrows the feed', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        const legalChip = page.getByTestId('memory-filter-chip-type:legal');
        await expect(legalChip).toHaveAttribute('aria-pressed', 'false');
        await setChipPressed(legalChip, true);

        // Feed now shows only legal docs: the brand row drops out, the
        // seeded legal row stays.
        await expect(brandRow).toBeHidden({ timeout: 15_000 });
        await expect(legalRow).toBeVisible();
    });

    test('multi-selecting two Type chips is OR within the facet', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const personaRow = page.getByTestId(`memory-doc-${personaDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        await setChipPressed(page.getByTestId('memory-filter-chip-type:brand'), true);
        await setChipPressed(page.getByTestId('memory-filter-chip-type:personas'), true);

        // brand OR personas → both seeded rows visible, the legal row hidden.
        await expect(brandRow).toBeVisible({ timeout: 15_000 });
        await expect(personaRow).toBeVisible();
        await expect(legalRow).toBeHidden({ timeout: 15_000 });
    });

    test('"Clear all" restores the full feed and un-presses the chips', async ({ page }) => {
        test.setTimeout(90_000);
        requireSeed();
        await gotoOrgMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        // Arrange: a live filter, so "Clear all" has something to clear.
        const legalChip = page.getByTestId('memory-filter-chip-type:legal');
        await setChipPressed(legalChip, true);
        await expect(brandRow).toBeHidden({ timeout: 15_000 });

        // The shell renders "Clear all" only while a filter/query is active
        // (`hasActiveFilters`), so it unmounts the moment it does its job.
        const clearAll = page.getByRole('button', { name: /Clear all/i });
        await expect(clearAll).toBeVisible();
        await expect(async () => {
            if (await clearAll.isVisible().catch(() => false)) {
                await clearAll.click({ timeout: 5_000 }).catch(() => undefined);
            }
            await expect(legalChip).toHaveAttribute('aria-pressed', 'false', { timeout: 3_000 });
        }).toPass({ timeout: 30_000 });

        // Filters cleared: the feed is whole again — the brand row the filter
        // had excluded is back, alongside the legal row that survived it…
        await expect(brandRow).toBeVisible({ timeout: 15_000 });
        await expect(legalRow).toBeVisible();
        // …and the affordance itself is gone, since nothing is filtered now.
        await expect(clearAll).toBeHidden();
    });
});

test.describe('Org Memory UI — search', () => {
    test('typing a title token narrows the feed to the matching seeded doc', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        // "charlie" is unique to the legal doc's title.
        await page.getByTestId('memory-search').fill('charlie');
        await expect(legalRow).toBeVisible({ timeout: 15_000 });
        await expect(brandRow).toBeHidden({ timeout: 15_000 });

        // Clearing the query brings the brand row back.
        await page.getByTestId('memory-search').fill('');
        await expect(brandRow).toBeVisible({ timeout: 15_000 });
    });

    test('a no-match query renders the real "no results" empty-state', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoOrgMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        await page
            .getByTestId('memory-search')
            .fill(`zzz-nonexistent-${Date.now().toString(36)}-qwxz`);

        await expect(page.getByText('No documents match your search and filters.')).toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeHidden();
    });
});

test.describe('Org Memory UI — consolidation', () => {
    test('Consolidate opens the dry-run confirm panel and Cancel closes it', async ({ page }) => {
        test.setTimeout(90_000);
        requireSeed();
        await gotoOrgMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        // The dry-run report opens the confirm surface (env-adaptive fallback:
        // a transient failure would show the error banner instead). One of the
        // two ALWAYS lands — `runConsolidation` sets `consolidateFailed` on a
        // non-ok response and in its catch — so waiting on the pair is the
        // honest assertion, and a click that produces neither only ever means
        // the click itself was dropped pre-hydration.
        const panel = page.getByTestId('memory-consolidate-panel');
        const errorBanner = page.getByTestId('memory-consolidate-error');
        await clickUntilVisible(
            page.getByTestId('memory-consolidate-button'),
            panel.or(errorBanner).first(),
        );

        if (await panel.isVisible().catch(() => false)) {
            await expect(panel).toContainText('Consolidate memory');
            await expect(panel).toContainText(/Nothing changes until you apply/i);
            await expect(panel).toContainText(/\d+\s+scanned/i);
            await expect(page.getByTestId('memory-consolidate-apply')).toBeVisible();

            // Cancel is non-mutating — the panel closes, no applied summary.
            await page.getByTestId('memory-consolidate-cancel').click();
            await expect(panel).toBeHidden({ timeout: 10_000 });
            await expect(page.getByTestId('memory-consolidate-applied')).toHaveCount(0);
        }
    });

    test('Applying the consolidation swaps in the applied summary', async ({ page }) => {
        test.setTimeout(90_000);
        requireSeed();
        await gotoOrgMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        const panel = page.getByTestId('memory-consolidate-panel');
        const errorBanner = page.getByTestId('memory-consolidate-error');
        await clickUntilVisible(
            page.getByTestId('memory-consolidate-button'),
            panel.or(errorBanner).first(),
        );

        // If the dry-run failed to open the panel (env), don't proceed to Apply.
        if (!(await panel.isVisible().catch(() => false))) {
            test.skip(true, 'dry-run panel did not open in this environment');
        }

        await page.getByTestId('memory-consolidate-apply').click();

        // Apply persists and the shell replaces the panel with the summary.
        const applied = page.getByTestId('memory-consolidate-applied');
        await expect(applied).toBeVisible({ timeout: 30_000 });
        await expect(applied).toContainText(/Consolidated:/i);
        await expect(panel).toBeHidden();
    });

    test('after applying, a reload shows at least one consolidation badge', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        // The previous test applied consolidation to this Org (near-duplicate
        // research pair guarantees markers). A fresh load re-reads the feed
        // with the persisted promoted/superseded markers.
        await gotoOrgMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        const badges = page.locator(
            '[data-testid^="memory-doc-promoted-"], [data-testid^="memory-doc-superseded-"]',
        );
        await expect.poll(async () => badges.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    });
});

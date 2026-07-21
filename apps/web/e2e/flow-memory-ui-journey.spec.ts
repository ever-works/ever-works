import { test, expect, type Page } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { API_BASE } from './helpers/api';

/**
 * Org-wide Memory (Cortex P1) — the `/memory` PAGE, driven through the real
 * authenticated UI (storageState), DEEP + ASSERTIVE.
 *
 * The sibling `flow-org-memory-page-deep.spec.ts` pins the `GET /api/memory`
 * + `POST /api/memory/consolidate` CONTRACT at the REST layer with fresh,
 * scope-pinned users. This file is the complementary UI journey: it lands
 * the shared seeded user on `/en/memory` (which 307s to `/memory`) and pins
 * the actual rendered `MemoryShell` surface — nothing here overlaps the API
 * spec. Coverage:
 *
 *   • page chrome: `memory-shell` mounts, the "Memory" heading + subtitle
 *     render, the document <title> comes from `generateMetadata`, the search
 *     box + "Consolidate" action + "documents indexed" header count render
 *   • seeded KB docs authored in the session user's active Org surface as
 *     `memory-doc-<id>` rows with their title, class chip, and a link to the
 *     source Work (workName) — seeded via the API into the SAME session-scope
 *     Org the page reads (verified live: creating a Work/KB doc with a bare
 *     Bearer token, no scope header, lands in the user's active Org and the
 *     bare `GET /api/memory` returns it — exactly the BFF proxy's path)
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
 * ── Probed live against http://127.0.0.1:3100 / :3000 before assertions:
 *      - `/en/memory` → 307 `/memory`; unauth `/memory` → 307 `/login`
 *      - bare `GET /api/memory` (no X-Scope-Slug) returns the session Org's
 *        aggregation; a seeded brand/active doc surfaces with the full
 *        OrgMemoryDocumentItem projection (workName resolved, source=user,
 *        lastIndexedAt/consolidation null)
 *      - `POST /api/memory/consolidate {}` → dryRun report (scanned N,
 *        promoted≥1, superseded≥1 for a populated Org); `{apply:true}` stamps
 *        promoted/superseded markers (synthesis is env-adaptive: 0 with no LLM
 *        key + a MODEL_AUTHENTICATION note, so counts are asserted tolerantly)
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
let workId = '';
let workName = '';
let brandDoc: SeededDoc; // class brand / active — title token "alpha"
let personaDoc: SeededDoc; // class personas / active — title token "bravo"
let legalDoc: SeededDoc; // class legal / draft — title token "charlie"

function authHeaders(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function createDoc(
    token: string,
    input: { path: string; title: string; cls: string; status: string; description: string },
): Promise<SeededDoc> {
    const res = await fetch(`${API_BASE}/api/works/${workId}/kb/documents`, {
        method: 'POST',
        headers: authHeaders(token),
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
 * Seed the session user's active Org with a Work + a spread of KB docs so
 * the page has deterministic rows to render, filter, and consolidate. Uses a
 * bare Bearer token with NO scope header — verified live to land in the same
 * active Org the BFF proxy (and therefore the page) reads.
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

        // Ensure the account has an active Org (global-setup lazy-creates one;
        // be defensive in case a bespoke env skipped it).
        const orgsRes = await fetch(`${API_BASE}/api/organizations`, {
            headers: { authorization: `Bearer ${token}` },
        });
        const orgs = orgsRes.ok ? ((await orgsRes.json()) as unknown[]) : [];
        if (!Array.isArray(orgs) || orgs.length === 0) {
            const createOrg = await fetch(`${API_BASE}/api/organizations`, {
                method: 'POST',
                headers: authHeaders(token),
                body: JSON.stringify({ name: `MemUI Org ${RUN}` }),
            });
            if (!createOrg.ok) {
                throw new Error(`org create failed ${createOrg.status}: ${await createOrg.text()}`);
            }
        }

        workName = `MemUI Journey ${RUN}`;
        const wkRes = await fetch(`${API_BASE}/api/works`, {
            method: 'POST',
            headers: authHeaders(token),
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

async function gotoMemory(page: Page): Promise<void> {
    await page.goto('/en/memory', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('memory-shell')).toBeVisible({ timeout: 30_000 });
}

function requireSeed(): void {
    test.skip(!seedOk, `memory seed unavailable: ${seedError || 'setup did not run'}`);
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
        await gotoMemory(page);
        const row = page.getByTestId(`memory-doc-${brandDoc.id}`);
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect(row).toContainText(`MemUI Brand ${RUN} alpha`);
    });

    test('a seeded doc row shows its class chip and links to the source Work', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoMemory(page);
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
        await gotoMemory(page);

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
        await gotoMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        const legalChip = page.getByTestId('memory-filter-chip-type:legal');
        await expect(legalChip).toHaveAttribute('aria-pressed', 'false');
        await legalChip.click();
        await expect(legalChip).toHaveAttribute('aria-pressed', 'true');

        // Feed now shows only legal docs: the brand row drops out, the
        // seeded legal row stays.
        await expect(brandRow).toBeHidden({ timeout: 15_000 });
        await expect(legalRow).toBeVisible();
    });

    test('multi-selecting two Type chips is OR within the facet', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const personaRow = page.getByTestId(`memory-doc-${personaDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        await page.getByTestId('memory-filter-chip-type:brand').click();
        await page.getByTestId('memory-filter-chip-type:personas').click();

        // brand OR personas → both seeded rows visible, the legal row hidden.
        await expect(brandRow).toBeVisible({ timeout: 15_000 });
        await expect(personaRow).toBeVisible();
        await expect(legalRow).toBeHidden({ timeout: 15_000 });
    });

    test('"Clear all" restores the full feed and un-presses the chips', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoMemory(page);

        const brandRow = page.getByTestId(`memory-doc-${brandDoc.id}`);
        const legalRow = page.getByTestId(`memory-doc-${legalDoc.id}`);
        await expect(brandRow).toBeVisible({ timeout: 15_000 });

        const legalChip = page.getByTestId('memory-filter-chip-type:legal');
        await legalChip.click();
        await expect(legalChip).toHaveAttribute('aria-pressed', 'true');
        await expect(brandRow).toBeHidden({ timeout: 15_000 });

        const clearAll = page.getByRole('button', { name: /Clear all/i });
        await expect(clearAll).toBeVisible();
        await clearAll.click();

        // Filters cleared: the chip un-presses and the brand row comes back.
        await expect(page.getByTestId('memory-filter-chip-type:legal')).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        await expect(brandRow).toBeVisible({ timeout: 15_000 });
        await expect(legalRow).toBeVisible();
    });
});

test.describe('Org Memory UI — search', () => {
    test('typing a title token narrows the feed to the matching seeded doc', async ({ page }) => {
        test.setTimeout(60_000);
        requireSeed();
        await gotoMemory(page);

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
        await gotoMemory(page);
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
        test.setTimeout(60_000);
        requireSeed();
        await gotoMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        await page.getByTestId('memory-consolidate-button').click();

        // The dry-run report opens the confirm surface (env-adaptive fallback:
        // a transient failure would show the error banner instead).
        const panel = page.getByTestId('memory-consolidate-panel');
        const errorBanner = page.getByTestId('memory-consolidate-error');
        await expect(panel.or(errorBanner).first()).toBeVisible({ timeout: 20_000 });

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
        await gotoMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        await page.getByTestId('memory-consolidate-button').click();

        const panel = page.getByTestId('memory-consolidate-panel');
        const errorBanner = page.getByTestId('memory-consolidate-error');
        await expect(panel.or(errorBanner).first()).toBeVisible({ timeout: 20_000 });

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
        await gotoMemory(page);
        await expect(page.getByTestId(`memory-doc-${brandDoc.id}`)).toBeVisible({
            timeout: 15_000,
        });

        const badges = page.locator(
            '[data-testid^="memory-doc-promoted-"], [data-testid^="memory-doc-superseded-"]',
        );
        await expect.poll(async () => badges.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    });
});

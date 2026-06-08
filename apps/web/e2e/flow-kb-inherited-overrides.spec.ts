import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createOrganizationViaAPI } from './helpers/organizations';
import { seedOrgKbDoc, setWorkOrganizationId } from './helpers/kb-fixtures';

/**
 * Knowledge Base — inherited-doc OVERRIDE matrix (EW-641 Phase 2/e, #1192).
 *
 * Complex, multi-entity orchestration of the org→Work KB inheritance +
 * override resolution path. Each flow seeds org-scope inheritable docs,
 * pairs a Work with the org, creates Work-scope overrides at the SAME
 * path, and asserts the OBSERVABLE effect on the resolution API
 * (`GET /works/:id/kb/inheritable`).
 *
 * The core behaviour under test is the #1192 `doc.workId === null` filter:
 * the inheritable endpoint returns the MERGED effective set
 * (`resolveInheritableDocuments` — org docs keyed by path, Work overrides
 * shadowing org docs at the same path), so once a Work overrides an
 * inherited doc, that path comes back as a Work-OWNED row (`workId !== null`).
 *
 * ───────────────────────────────────────────────────────────────────────
 * WORKBENCH-UI MIGRATION (EW-641 slices A/C):
 *
 * The OLD KB tree (`components/works/detail/kb/KbTreePanel.tsx`) rendered a
 * dedicated "Inherited from organization" section with per-row testids
 * (`kb-tree-inherited`, `kb-tree-inherited-<class>-<slug>`). The NEW
 * workbench tree (`components/kb/workbench/KbTreePanel.tsx`, line ~46)
 * explicitly defers inherited-scope tree affordances to slices C and E —
 * it ONLY fetches Work-owned docs (`/api/works/:id/kb/documents`) and groups
 * them by class. There is NO inherited section and NO `kb-tree-inherited-*`
 * testids in the workbench today.
 *
 * Consequently the API-level inheritance assertions below remain fully
 * valid and run as-is (only the data-setup seeding fix is applied: a REAL
 * org via `createOrganizationViaAPI` instead of a fabricated UUID, because
 * the org-KB endpoint now validates the org exists). The inherited-TREE-UI
 * assertions are split out into companion `test.skip(...)` tests so the
 * suite stays green until slices C/E build the inherited section. Those
 * skipped tests carry the migrated workbench selectors (kb-workbench-shell,
 * kb-workbench-tree, kb-workbench-group-<class>, kb-workbench-row-<id>) so
 * they are ready to re-enable once the inherited section exists.
 *
 * ───────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API BEFORE WRITING:
 *
 *   POST /api/organizations { name }                 -> 201 { id, ... } (real org)
 *   POST /api/works                                  -> { status:'success', work:{ id, ... } }
 *   POST /api/organizations/:orgId/kb/documents      -> 201 KbDocumentBodyDto
 *        { id, workId:null, organizationId:<orgId>, path, slug, title, class:'legal',
 *          status:'active', body, assets:[] }   (class restricted to legal|style|seo)
 *   PATCH /api/works/:id { organizationId }          -> 200 { work:{ organizationId } }
 *   GET  /api/works/:id/kb/inheritable?orgId=<orgId> -> KbDocumentDto[]  (merged effective set)
 *        - pre-override:   both org docs present with workId === null
 *        - partial override of legal/privacy.md:
 *            legal/privacy.md -> workId !== null (Work-owned override masks it)
 *            legal/terms.md   -> workId === null (still inherited)
 *        - full override (both paths): every entry workId !== null
 *            => orgScoped (workId === null) count == 0
 *   POST /api/works/:id/kb/documents                 -> 201 KbDocumentBodyDto
 *        { id, workId:<workId>, organizationId:null, path, slug, ... }  (Work-scope override)
 *   GET  /api/works/:id/kb/documents?limit=200       -> { items:KbDocumentDto[], total } (Work-owned only)
 *
 *   ISOLATION: the inheritable endpoint TRUSTS the `orgId` query param — it
 *   does not re-verify the Work belongs to that org. The KB page server
 *   component drives `orgId` from `work.organizationId`, so a Work paired
 *   with a DIFFERENT (empty) org resolves `[]` and never shows org-A's docs.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WORKBENCH UI SELECTORS (verified against KbTreePanel.tsx / WorkbenchShell.tsx):
 *   - kb-workbench-shell                    (WorkbenchShell root)
 *   - kb-workbench-tree                     (KbTreePanel root; data-work-id)
 *   - kb-workbench-group-<class>            (data-kb-class) per-class Work-owned group
 *   - kb-workbench-row-<documentId>         (data-doc-path) Work-owned doc row
 *   NOT YET BUILT (deferred to slices C/E): the inherited section and its
 *   kb-tree-inherited-* row testids.
 */

const KB_PAGE_TIMEOUT = 180_000;

const INHERITED_TREE_DEFERRED =
    'workbench inherited-tree UI deferred to EW-641 slices C/E — re-enable when built';

type InheritableDoc = {
    id: string;
    workId: string | null;
    organizationId: string | null;
    path: string;
    slug: string;
    title: string;
    class: string;
};

/** GET the merged effective inheritable set for a Work (deterministic API assertion source). */
async function resolveInheritableViaAPI(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    workId: string,
    orgId: string,
): Promise<InheritableDoc[]> {
    const res = await request.get(
        `${API_BASE}/api/works/${workId}/kb/inheritable?orgId=${encodeURIComponent(orgId)}`,
        { headers: authedHeaders(token) },
    );
    expect(res.ok(), `GET inheritable should be 200, got ${res.status()}`).toBeTruthy();
    return (await res.json()) as InheritableDoc[];
}

/** Create a Work-scope KB document (an override when path collides with an org doc). */
async function createWorkKbDoc(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    workId: string,
    doc: { path: string; title: string; body: string; class?: string },
): Promise<InheritableDoc> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
        headers: authedHeaders(token),
        data: {
            path: doc.path,
            title: doc.title,
            class: doc.class ?? 'legal',
            body: doc.body,
        },
    });
    expect(res.ok(), `POST Work-scope KB doc should be 201, got ${res.status()}`).toBeTruthy();
    return (await res.json()) as InheritableDoc;
}

test.describe('Knowledge Base — inherited override matrix (#1192)', () => {
    test('partial override (API): overridden doc leaves the inherited set, others stay inherited', async ({
        request,
    }) => {
        test.setTimeout(KB_PAGE_TIMEOUT);

        // 1. Seeded-user bearer token so API mutations land on the UI's
        //    logged-in user. LOGIN DTO is whitelisted to {email,password}.
        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        expect(token, 'loginViaAPI must return an access_token').toBeTruthy();

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // A REAL organization owned by the seeded user. The org-scope KB
        // endpoint now enforces tenant ownership (the audit's cross-tenant
        // IDOR fix), so a bare random UUID 404s — the org row must exist and
        // belong to the caller's tenant. `randomUUID()` only supplies a
        // collision-proof display name here.
        const orgId = (await createOrganizationViaAPI(request, token, `kb-org-${randomUUID()}`)).id;

        // 2. Fresh Work owned by the seeded user.
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Partial Override ${runId}`,
        });
        expect(workId, 'createWorkViaAPI must return a work id').toBeTruthy();

        // 3. Seed TWO org-scope inheritable docs at distinct paths.
        const privacyTitle = `Privacy ${runId}`;
        const termsTitle = `Terms ${runId}`;
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: privacyTitle,
            targetClass: 'legal',
            body: `# ${privacyTitle}\n\nOrg-level privacy policy inherited by paired Works.\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/terms.md',
            title: termsTitle,
            targetClass: 'legal',
            body: `# ${termsTitle}\n\nOrg-level terms of service inherited by paired Works.\n`,
        });

        // 4. Pair the Work with the org so the inheritable resolution surfaces both docs.
        await setWorkOrganizationId(request, token, workId, orgId);

        // 5. API truth (pre-override): both docs resolve as org-scoped (workId === null).
        const before = await resolveInheritableViaAPI(request, token, workId, orgId);
        const beforeOrgScoped = before.filter((d) => d.workId === null).map((d) => d.path);
        expect(beforeOrgScoped).toContain('legal/privacy.md');
        expect(beforeOrgScoped).toContain('legal/terms.md');

        // 6. Create a WORK-scope override of legal/privacy.md (same path).
        const override = await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nWork-scope override of the org privacy policy.\n`,
        });
        expect(override.workId, 'override must be Work-scoped').toBe(workId);
        expect(override.organizationId, 'override must not carry an org id').toBeNull();
        expect(override.path).toBe('legal/privacy.md');

        // 7. API truth (post-partial-override): the merged set now returns
        //    legal/privacy.md as Work-OWNED (workId !== null) and legal/terms.md
        //    still org-scoped (workId === null) — the #1192 filter boundary.
        const after = await resolveInheritableViaAPI(request, token, workId, orgId);
        const privacyEntry = after.find((d) => d.path === 'legal/privacy.md');
        const termsEntry = after.find((d) => d.path === 'legal/terms.md');
        expect(privacyEntry, 'privacy still in merged set').toBeTruthy();
        expect(termsEntry, 'terms still in merged set').toBeTruthy();
        expect(privacyEntry?.workId, 'overridden privacy is now Work-owned').toBe(workId);
        expect(termsEntry?.workId, 'un-overridden terms stays org-scoped').toBeNull();
        // Exactly one doc remains genuinely inherited (org-scoped).
        expect(after.filter((d) => d.workId === null).map((d) => d.path)).toEqual([
            'legal/terms.md',
        ]);

        // 8. And the Work-owned list now carries the override at that path.
        const docsRes = await request.get(`${API_BASE}/api/works/${workId}/kb/documents?limit=200`, {
            headers: authedHeaders(token),
        });
        expect(docsRes.ok()).toBeTruthy();
        const docsBody = (await docsRes.json()) as { items: InheritableDoc[]; total: number };
        const ownedPaths = docsBody.items.map((d) => d.path);
        expect(ownedPaths, 'override surfaces as a Work-owned doc').toContain('legal/privacy.md');
        // terms was never overridden, so it is NOT a Work-owned doc.
        expect(ownedPaths, 'un-overridden terms is not Work-owned').not.toContain('legal/terms.md');
    });

    // The OLD test asserted the inherited TREE UI (kb-tree-inherited section,
    // kb-tree-inherited-legal-privacy / -terms rows, and the overridden doc
    // moving into the Work-owned tree). The workbench has not built the
    // inherited section yet (KbTreePanel.tsx line ~46 → slices C/E), so this
    // UI half is skipped but kept (with migrated workbench selectors) for
    // re-enablement once the section lands.
    test('partial override (UI): inherited section shows terms, drops overridden privacy', async ({
        page,
        request,
    }) => {
        test.skip(true, INHERITED_TREE_DEFERRED);
        test.setTimeout(KB_PAGE_TIMEOUT);

        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const orgId = (await createOrganizationViaAPI(request, token, `kb-org-${randomUUID()}`)).id;
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Partial Override UI ${runId}`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: `# Privacy ${runId}\n\nOrg privacy.\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/terms.md',
            title: `Terms ${runId}`,
            targetClass: 'legal',
            body: `# Terms ${runId}\n\nOrg terms.\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);
        await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nWork override.\n`,
        });

        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-workbench-tree')).toBeVisible({ timeout: 30_000 });

        // TODO(EW-641 slices C/E): once the workbench builds the inherited
        // section, assert here that the inherited list shows legal/terms.md
        // and DROPS the overridden legal/privacy.md, and that the override
        // surfaces as a Work-owned row:
        //   const overrideRow = page.locator(
        //       '[data-testid^="kb-workbench-row-"][data-doc-path="legal/privacy.md"]',
        //   );
        //   await expect(overrideRow).toBeVisible();
    });

    test('full override (API): every former-inherited doc becomes Work-owned, none stay inherited', async ({
        request,
    }) => {
        test.setTimeout(KB_PAGE_TIMEOUT);

        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        expect(token).toBeTruthy();

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // A REAL organization owned by the seeded user. The org-scope KB
        // endpoint now enforces tenant ownership (the audit's cross-tenant
        // IDOR fix), so a bare random UUID 404s — the org row must exist and
        // belong to the caller's tenant. `randomUUID()` only supplies a
        // collision-proof display name here.
        const orgId = (await createOrganizationViaAPI(request, token, `kb-org-${randomUUID()}`)).id;

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Full Override ${runId}`,
        });
        expect(workId).toBeTruthy();

        // Seed two org-scope inheritable docs across two distinct paths.
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: `# Privacy ${runId}\n\nOrg privacy.\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/terms.md',
            title: `Terms ${runId}`,
            targetClass: 'legal',
            body: `# Terms ${runId}\n\nOrg terms.\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);

        // Sanity: both inherited before any override.
        const before = await resolveInheritableViaAPI(request, token, workId, orgId);
        expect(
            before
                .filter((d) => d.workId === null)
                .map((d) => d.path)
                .sort(),
        ).toEqual(['legal/privacy.md', 'legal/terms.md']);

        // Override BOTH inherited docs at their org paths (full override).
        await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nFull override.\n`,
        });
        await createWorkKbDoc(request, token, workId, {
            path: 'legal/terms.md',
            title: `Terms OVERRIDE ${runId}`,
            body: `# Terms OVERRIDE ${runId}\n\nFull override.\n`,
        });

        // API truth: the merged set still returns both paths, but EVERY entry
        // is now Work-owned (workId !== null) => zero org-scoped docs remain.
        const after = await resolveInheritableViaAPI(request, token, workId, orgId);
        expect(after.map((d) => d.path).sort()).toEqual(['legal/privacy.md', 'legal/terms.md']);
        expect(
            after.every((d) => d.workId === workId),
            'every doc now Work-owned',
        ).toBeTruthy();
        expect(
            after.filter((d) => d.workId === null).length,
            'no genuinely-inherited (org-scoped) docs left',
        ).toBe(0);

        // And the Work-owned list now carries both overrides.
        const docsRes = await request.get(`${API_BASE}/api/works/${workId}/kb/documents?limit=200`, {
            headers: authedHeaders(token),
        });
        expect(docsRes.ok()).toBeTruthy();
        const docsBody = (await docsRes.json()) as { items: InheritableDoc[]; total: number };
        const ownedPaths = docsBody.items.map((d) => d.path);
        expect(ownedPaths).toContain('legal/privacy.md');
        expect(ownedPaths).toContain('legal/terms.md');
        // Work-owned docs are never org-scoped.
        for (const d of docsBody.items) {
            expect(d.workId, `Work doc ${d.path} must be Work-scoped`).toBe(workId);
        }
    });

    // The OLD test asserted that, with zero org-scoped docs remaining, the
    // inherited TREE section unmounts entirely while both former-inherited
    // docs render as Work-owned rows under the legal group. The workbench
    // inherited section is not built yet (slices C/E), so the inherited-
    // section-unmount assertion cannot run; the Work-owned-group half IS
    // supported by the workbench and is kept here for re-enablement.
    test('full override (UI): inherited section empties, Work owns every former inherited doc', async ({
        page,
        request,
    }) => {
        test.skip(true, INHERITED_TREE_DEFERRED);
        test.setTimeout(KB_PAGE_TIMEOUT);

        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const orgId = (await createOrganizationViaAPI(request, token, `kb-org-${randomUUID()}`)).id;
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Full Override UI ${runId}`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: `# Privacy ${runId}\n\nOrg privacy.\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/terms.md',
            title: `Terms ${runId}`,
            targetClass: 'legal',
            body: `# Terms ${runId}\n\nOrg terms.\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);
        await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nFull override.\n`,
        });
        await createWorkKbDoc(request, token, workId, {
            path: 'legal/terms.md',
            title: `Terms OVERRIDE ${runId}`,
            body: `# Terms OVERRIDE ${runId}\n\nFull override.\n`,
        });

        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-workbench-tree')).toBeVisible({ timeout: 30_000 });

        // The Work-owned group + both overridden rows are supported by the
        // workbench tree today.
        await expect(page.getByTestId('kb-workbench-group-legal')).toBeVisible({ timeout: 15_000 });
        await expect(
            page.locator('[data-testid^="kb-workbench-row-"][data-doc-path="legal/privacy.md"]'),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
            page.locator('[data-testid^="kb-workbench-row-"][data-doc-path="legal/terms.md"]'),
        ).toBeVisible({ timeout: 15_000 });

        // TODO(EW-641 slices C/E): once the inherited section is built, assert
        // it has fully unmounted here (no inherited rows remain).
    });

    test('inheritance isolation (API): org-A doc inherited by Work A is not inherited by unrelated Work B', async ({
        request,
    }) => {
        test.setTimeout(KB_PAGE_TIMEOUT);

        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        expect(token).toBeTruthy();

        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // Two REAL organizations owned by the seeded user (org-scope KB now
        // enforces tenant ownership — bare UUIDs 404). orgA owns the
        // isolation doc; orgB is intentionally left empty.
        const orgA = (await createOrganizationViaAPI(request, token, `kb-orgA-${randomUUID()}`)).id;
        const orgB = (await createOrganizationViaAPI(request, token, `kb-orgB-${randomUUID()}`)).id;
        expect(orgA).not.toBe(orgB);

        // Work A paired with org A (which owns a unique inheritable doc).
        const { id: workAId } = await createWorkViaAPI(request, token, {
            name: `KB Isolation A ${runId}`,
        });
        // Work B paired with a DIFFERENT, empty org B.
        const { id: workBId } = await createWorkViaAPI(request, token, {
            name: `KB Isolation B ${runId}`,
        });
        expect(workAId).toBeTruthy();
        expect(workBId).toBeTruthy();
        expect(workAId).not.toBe(workBId);

        // A run-unique path so cross-spec org docs can never collide with our
        // assertion (the org-doc endpoint is global per orgId, and orgA is a
        // fresh org, so this path is exclusively ours).
        const isoPath = `legal/isolation-${runId}.md`;
        const isoTitle = `Isolation Policy ${runId}`;
        await seedOrgKbDoc(request, token, {
            orgId: orgA,
            path: isoPath,
            title: isoTitle,
            targetClass: 'legal',
            body: `# ${isoTitle}\n\nOnly org A owns this; only Work A should inherit it.\n`,
        });

        await setWorkOrganizationId(request, token, workAId, orgA);
        await setWorkOrganizationId(request, token, workBId, orgB);

        // API truth: Work A (org A) inherits the doc; Work B (org B, empty)
        // resolves to no org-scoped docs. The KB page drives orgId from
        // work.organizationId, so Work B never asks about org A.
        const inheritedByA = await resolveInheritableViaAPI(request, token, workAId, orgA);
        expect(inheritedByA.filter((d) => d.workId === null).map((d) => d.path)).toContain(isoPath);

        const inheritedByB = await resolveInheritableViaAPI(request, token, workBId, orgB);
        expect(
            inheritedByB.filter((d) => d.workId === null).map((d) => d.path),
            'Work B (org B) must not inherit org A docs',
        ).not.toContain(isoPath);
        expect(inheritedByB.length, 'org B owns no inheritable docs').toBe(0);
    });

    // The OLD test asserted the inherited TREE section listed the isolation
    // doc for Work A and was absent for Work B. The workbench inherited
    // section is not built yet (slices C/E), so the UI half is skipped but
    // kept with migrated workbench selectors for re-enablement.
    test('inheritance isolation (UI): inherited section shows org-A doc only for Work A', async ({
        page,
        request,
    }) => {
        test.skip(true, INHERITED_TREE_DEFERRED);
        test.setTimeout(KB_PAGE_TIMEOUT);

        const seeded = loadSeededTestUser();
        const { access_token: token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const orgA = (await createOrganizationViaAPI(request, token, `kb-orgA-${randomUUID()}`)).id;
        const orgB = (await createOrganizationViaAPI(request, token, `kb-orgB-${randomUUID()}`)).id;
        const { id: workAId } = await createWorkViaAPI(request, token, {
            name: `KB Isolation A UI ${runId}`,
        });
        const { id: workBId } = await createWorkViaAPI(request, token, {
            name: `KB Isolation B UI ${runId}`,
        });
        const isoPath = `legal/isolation-${runId}.md`;
        const isoTitle = `Isolation Policy ${runId}`;
        await seedOrgKbDoc(request, token, {
            orgId: orgA,
            path: isoPath,
            title: isoTitle,
            targetClass: 'legal',
            body: `# ${isoTitle}\n\nOnly org A owns this.\n`,
        });
        await setWorkOrganizationId(request, token, workAId, orgA);
        await setWorkOrganizationId(request, token, workBId, orgB);

        // Work A workbench loads.
        await page.goto(`/en/works/${workAId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-workbench-tree')).toBeVisible({ timeout: 30_000 });

        // Work B workbench loads.
        await page.goto(`/en/works/${workBId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-workbench-tree')).toBeVisible({ timeout: 30_000 });

        // TODO(EW-641 slices C/E): once the inherited section is built, assert
        // Work A's inherited list contains the isolation doc and Work B's does
        // not (and never mounts the section at all).
    });
});

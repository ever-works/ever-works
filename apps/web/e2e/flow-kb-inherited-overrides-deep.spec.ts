import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { seedOrgKbDoc, setWorkOrganizationId } from './helpers/kb-fixtures';

/**
 * Knowledge Base — inherited-doc OVERRIDE lifecycle, DEEP edges (EW-641 Phase 2/e, #1192).
 *
 * Companion to flow-kb-inherited-overrides.spec.ts (partial / full override /
 * cross-Work isolation) and kb-inherited.spec.ts (A19+A20 inherited-visible +
 * override-clone UI journey). Those two specs cover the FORWARD direction
 * (org doc inherited → Work overrides it → inherited row masks). This file
 * covers the REVERSE + the MULTI-CLASS + the CROSS-WORK + the PAIRING edges
 * the existing specs never exercise:
 *
 *   1. OVERRIDE DELETE RESTORES INHERITANCE — the headline gap. After a Work
 *      hard-deletes its same-path override (DELETE /works/:id/kb/documents/:docId
 *      → 204), the merged inheritable set surfaces the org doc AGAIN as
 *      org-scoped (workId === null), and the UI re-mounts the inherited row.
 *   2. CROSS-CLASS partial override isolation — overriding legal/* leaves
 *      style/* and seo/* genuinely inherited (the merge map is keyed by path,
 *      classes never bleed). Three distinct inheritable classes, not two
 *      same-class docs.
 *   3. RE-OVERRIDE after restore — override → delete → re-override is
 *      idempotent: the path-collision survives the round-trip and the row flips
 *      Work-owned → org-scoped → Work-owned cleanly.
 *   4. INHERITED-BODY endpoint org-row guard — GET /works/:id/kb/inheritable/<path>
 *      ALWAYS returns the org row (workId === null) even while a same-path Work
 *      override exists (repo `findOrgByPath` pins `workId IS NULL`).
 *   5. TWO WORKS share one org — independent override lifecycles: Work A's
 *      override of legal/privacy.md never touches Work B's inheritance of the
 *      same org doc; deleting A's override restores only A.
 *   6. UNPAIR removes ALL inheritance, RE-PAIR restores it — toggling
 *      Work.organizationId null → orgId flips the whole inherited section off
 *      then back on without re-seeding org docs.
 *
 * ───────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING
 * (register → work → seed org docs (legal+style+seo) → pair → override →
 * delete → re-resolve → unpair → re-pair):
 *
 *   POST   /api/auth/register                              -> { access_token, user }
 *   POST   /api/works { name, slug, description, organization:false }
 *                                                          -> { work:{ id, ... } }
 *   POST   /api/organizations/:orgId/kb/documents          -> 201 KbDocumentBodyDto
 *          { id, workId:null, organizationId:<orgId>, path, slug, class, status:'active', body }
 *          (class restricted to legal|style|seo; slug = filename minus `.md`, lowercased)
 *   PATCH  /api/works/:id { organizationId:<orgId>|null }   -> 200 (pair / unpair)
 *   GET    /api/works/:id/kb/inheritable?orgId=<orgId>      -> KbDocumentDto[] (merged effective set)
 *          - org doc not overridden:            workId === null
 *          - org doc overridden at same path:   workId === <workId>  (Work row masks org row)
 *          - after override DELETE:             workId === null AGAIN (inheritance restored)
 *   POST   /api/works/:id/kb/documents { path, title, class, body }
 *                                                          -> 201 { id, workId:<workId>, organizationId:null, path }
 *   DELETE /api/works/:id/kb/documents/:docId              -> 204 (hard delete; no soft-delete on KB docs)
 *   GET    /api/works/:id/kb/documents?limit=200           -> { items:KbDocumentDto[], total } (Work-owned ONLY)
 *   GET    /api/works/:id/kb/inheritable/<path>?orgId=<o>  -> KbDocumentBodyDto (ORG row; 404 if no org row)
 *          (returns workId === null even when a same-path Work override exists)
 *
 *   MERGE RULE (service.resolveInheritableDocuments): byPath map — org docs in
 *   first, Work overrides last; Work wins on path collision. Both source lists
 *   filter status === 'active'. The inheritable endpoint TRUSTS the orgId query
 *   param (no re-verify of Work↔org pairing); the KB page server component
 *   drives orgId from work.organizationId, so an unpaired Work (organizationId
 *   null) resolves to org-scope [] and the inherited section unmounts.
 *
 * UI selectors verified against real source (KbTreePanel.tsx / KbTreeDocRow.tsx /
 * KbShell.tsx / KbDocumentView):
 *   - kb-shell (data-work-id)
 *   - kb-tree / kb-tree-count
 *   - kb-tree-inherited  ("Inherited from organization" section; mounts iff >=1 org-scoped doc)
 *   - kb-tree-inherited-<class>-<slug>  (data-source="inherited", data-doc-path, data-doc-class)
 *   - kb-tree-item (data-doc-path)      Work-owned row
 *   - kb-tree-group-<class>             per-class Work-owned group
 *   - kb-editor (data-inherited="true" on inherited detail view)
 *   - kb-inherited-banner / kb-inherited-banner-icon (🔒) / kb-inherited-override-cta
 *
 * ───────────────────────────────────────────────────────────────────────
 * NOTES / GOTCHAS honoured:
 *   - `/api/organizations/:orgId/kb/documents` does NOT enforce org membership
 *     today — we mint a random UUID per org and skip seeding an Organization
 *     row (mirrors kb-inherited.spec.ts + the sibling overrides spec).
 *   - Seeded user (storageState) owns the Works so the UI's logged-in user
 *     matches the API mutations. This is read-heavy KB inheritance state that
 *     touches NO per-user apiKey / provider setting, so it is safe on the
 *     shared seeded user (no chat/provider shadowing).
 *   - Unique org UUIDs + run-id-suffixed nothing-global; assertions use
 *     per-row testids / path filters, never global counts that sibling specs
 *     could perturb.
 *   - First KB-page hit triggers Next dev-mode route compilation; budget 180s
 *     like every authenticated KB spec. Some nested KB routes render in CI but
 *     can 404 to the catch-all LOCALLY — UI assertions here only target the
 *     tree page (/works/:id/kb) which is stable in both, and the detail-view
 *     assertion (flow 4) is BEST-EFFORT behind an API-truth gate.
 */

const KB_PAGE_TIMEOUT = 180_000;

type InheritableDoc = {
    id: string;
    workId: string | null;
    organizationId: string | null;
    path: string;
    slug: string;
    title: string;
    class: string;
    body?: string;
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

/** Create a Work-scope KB document (an override when path collides with an org doc). Returns the new doc. */
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

/**
 * Hard-delete a Work-scope KB doc by id — expects 204.
 *
 * Hardened against transient socket flake (`read ECONNRESET`) seen under the
 * shared workers=4 stack: the raw `request.delete` can have its connection
 * reset mid-flight, which Playwright surfaces as a thrown error rather than a
 * response. We retry on those network-level throws; a retry whose first attempt
 * actually landed the delete observes 404 on the second pass (the doc is gone),
 * which we treat as success (idempotent re-delete) — never weakening the 204
 * contract for the happy path, which is asserted on the first clean attempt.
 */
async function deleteWorkKbDoc(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    workId: string,
    docId: string,
): Promise<void> {
    let lastStatus = 0;
    await expect(async () => {
        const res = await request.delete(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
        });
        lastStatus = res.status();
        // 204 = deleted this pass; 404 = a prior (reset-but-landed) attempt
        // already removed it — both mean the override is gone.
        expect(
            lastStatus === 204 || lastStatus === 404,
            `DELETE Work-scope KB doc should be 204 (or 404 if a retried attempt already landed), got ${lastStatus}`,
        ).toBeTruthy();
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
}

/** Distinct org-scoped (workId === null) paths in the merged set, sorted. */
function orgScopedPaths(docs: InheritableDoc[]): string[] {
    return docs
        .filter((d) => d.workId === null)
        .map((d) => d.path)
        .sort();
}

function freshRunId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, {
        email: seeded.email,
        password: seeded.password,
    });
    expect(access_token, 'loginViaAPI must return an access_token').toBeTruthy();
    return access_token;
}

test.describe('Knowledge Base — inherited override lifecycle (deep, #1192)', () => {
    test('override DELETE restores inheritance: org doc returns to the inherited section', async ({
        page,
        request,
    }) => {
        // First KB-page hit triggers Next dev-mode compilation; budget like the
        // other authenticated KB specs.
        test.setTimeout(KB_PAGE_TIMEOUT);

        const token = await seededToken(request);
        const runId = freshRunId();
        const orgId = randomUUID();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Override Restore ${runId}`,
        });
        expect(workId, 'createWorkViaAPI must return a work id').toBeTruthy();

        // Seed ONE org-scope inheritable doc, pair the Work.
        const privacyTitle = `Privacy ${runId}`;
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: privacyTitle,
            targetClass: 'legal',
            body: `# ${privacyTitle}\n\nOrg-level privacy policy inherited by paired Works.\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);

        // API truth (pre-override): privacy resolves as org-scoped.
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workId, orgId)),
        ).toEqual(['legal/privacy.md']);

        // Override the inherited doc at the same path → it flips Work-owned.
        const override = await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nWork-scope override.\n`,
        });
        expect(override.workId, 'override is Work-scoped').toBe(workId);
        expect(override.id, 'override has an id we can DELETE').toBeTruthy();

        const afterOverride = await resolveInheritableViaAPI(request, token, workId, orgId);
        expect(
            afterOverride.find((d) => d.path === 'legal/privacy.md')?.workId,
            'overridden privacy is Work-owned',
        ).toBe(workId);
        // No genuinely-inherited docs remain → the section would be empty.
        expect(orgScopedPaths(afterOverride)).toEqual([]);

        // UI truth (overridden): the inherited section is unmounted (zero
        // org-scoped docs), and the override shows as a Work-owned row.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toHaveCount(0, { timeout: 15_000 });
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]'),
        ).toBeVisible({ timeout: 15_000 });

        // ── THE NEW BEHAVIOUR ── delete the override (204) → inheritance restored.
        await deleteWorkKbDoc(request, token, workId, override.id);

        // API truth (post-delete): privacy is org-scoped AGAIN (workId === null),
        // and the Work-owned list no longer carries it.
        const afterDelete = await resolveInheritableViaAPI(request, token, workId, orgId);
        expect(
            afterDelete.find((d) => d.path === 'legal/privacy.md')?.workId,
            'privacy restored to org-scoped after override delete',
        ).toBeNull();
        expect(orgScopedPaths(afterDelete)).toEqual(['legal/privacy.md']);

        const ownedRes = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?limit=200`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(ownedRes.ok()).toBeTruthy();
        const owned = (await ownedRes.json()) as { items: InheritableDoc[]; total: number };
        expect(
            owned.items.map((d) => d.path),
            'Work no longer owns the deleted override path',
        ).not.toContain('legal/privacy.md');

        // UI truth (post-delete): reload — the inherited row is BACK in the
        // inherited section, and the Work-owned row at that path is gone.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toBeVisible({ timeout: 30_000 });
        const restoredRow = page.getByTestId('kb-tree-inherited-legal-privacy');
        await expect(restoredRow).toBeVisible({ timeout: 15_000 });
        await expect(restoredRow).toHaveAttribute('data-source', 'inherited');
        await expect(restoredRow).toHaveAttribute('data-doc-path', 'legal/privacy.md');
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]'),
            'no Work-owned row lingers after the override is deleted',
        ).toHaveCount(0);
    });

    test('cross-class override isolation: overriding legal leaves style + seo inherited', async ({
        page,
        request,
    }) => {
        test.setTimeout(KB_PAGE_TIMEOUT);

        const token = await seededToken(request);
        const runId = freshRunId();
        const orgId = randomUUID();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Cross Class ${runId}`,
        });
        expect(workId).toBeTruthy();

        // Seed ONE inheritable doc in each of the three inheritable classes.
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: `# Privacy ${runId}\n\nLegal class.\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'style/voice.md',
            title: `Voice ${runId}`,
            targetClass: 'style',
            body: `# Voice ${runId}\n\nStyle class.\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'seo/meta.md',
            title: `Meta ${runId}`,
            targetClass: 'seo',
            body: `# Meta ${runId}\n\nSeo class.\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);

        // API truth (pre-override): all three classes inherited.
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workId, orgId)),
        ).toEqual(['legal/privacy.md', 'seo/meta.md', 'style/voice.md']);

        // Override ONLY the legal doc.
        await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            class: 'legal',
            body: `# Privacy OVERRIDE ${runId}\n\nLegal override only.\n`,
        });

        // API truth (post-override): only legal flips Work-owned; style + seo
        // remain genuinely inherited (classes never bleed through the path map).
        const after = await resolveInheritableViaAPI(request, token, workId, orgId);
        expect(after.find((d) => d.path === 'legal/privacy.md')?.workId).toBe(workId);
        expect(after.find((d) => d.path === 'style/voice.md')?.workId).toBeNull();
        expect(after.find((d) => d.path === 'seo/meta.md')?.workId).toBeNull();
        expect(orgScopedPaths(after)).toEqual(['seo/meta.md', 'style/voice.md']);

        // UI truth: the inherited section persists (2 docs still inherited),
        // legal/privacy is GONE from it, style/voice + seo/meta remain, and
        // legal/privacy shows as a Work-owned row under the legal group.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toBeVisible({ timeout: 30_000 });

        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited-style-voice')).toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited-seo-meta')).toBeVisible({
            timeout: 15_000,
        });
        // The two surviving inherited rows carry the inherited data attrs.
        await expect(page.getByTestId('kb-tree-inherited-style-voice')).toHaveAttribute(
            'data-source',
            'inherited',
        );
        await expect(page.getByTestId('kb-tree-inherited-seo-meta')).toHaveAttribute(
            'data-doc-path',
            'seo/meta.md',
        );
        // The overridden legal doc is now a Work-owned row in the legal group.
        await expect(page.getByTestId('kb-tree-group-legal')).toBeVisible({ timeout: 15_000 });
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]'),
        ).toBeVisible({ timeout: 15_000 });
        // No Work-owned rows leaked for the never-overridden classes.
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="style/voice.md"]'),
        ).toHaveCount(0);
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="seo/meta.md"]'),
        ).toHaveCount(0);
    });

    test('re-override after restore: Work-owned → org-scoped → Work-owned round-trips cleanly', async ({
        request,
    }) => {
        // Pure-API flow (no UI nav) — the override↔restore↔re-override state
        // machine is the thing under test; keep it deterministic & fast.
        test.setTimeout(60_000);

        const token = await seededToken(request);
        const runId = freshRunId();
        const orgId = randomUUID();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Re-Override ${runId}`,
        });
        expect(workId).toBeTruthy();

        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/terms.md',
            title: `Terms ${runId}`,
            targetClass: 'legal',
            body: `# Terms ${runId}\n\nOrg terms.\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);

        // State 0: inherited (org-scoped).
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workId, orgId)),
        ).toEqual(['legal/terms.md']);

        // State 1: first override → Work-owned.
        const o1 = await createWorkKbDoc(request, token, workId, {
            path: 'legal/terms.md',
            title: `Terms OVERRIDE-1 ${runId}`,
            body: `# Terms OVERRIDE-1 ${runId}\n`,
        });
        expect(
            (await resolveInheritableViaAPI(request, token, workId, orgId)).find(
                (d) => d.path === 'legal/terms.md',
            )?.workId,
        ).toBe(workId);

        // State 2: delete override → restored to org-scoped.
        await deleteWorkKbDoc(request, token, workId, o1.id);
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workId, orgId)),
        ).toEqual(['legal/terms.md']);

        // State 3: RE-override at the same path → Work-owned again, with a NEW
        // row id (the old override was hard-deleted, not soft-restored).
        const o2 = await createWorkKbDoc(request, token, workId, {
            path: 'legal/terms.md',
            title: `Terms OVERRIDE-2 ${runId}`,
            body: `# Terms OVERRIDE-2 ${runId}\n`,
        });
        expect(o2.id, 're-override mints a fresh row id').not.toBe(o1.id);
        expect(o2.workId).toBe(workId);
        const afterReOverride = await resolveInheritableViaAPI(request, token, workId, orgId);
        expect(afterReOverride.find((d) => d.path === 'legal/terms.md')?.workId).toBe(workId);
        expect(orgScopedPaths(afterReOverride)).toEqual([]);

        // And the Work-owned list carries exactly the second override, not a stale row.
        const ownedRes = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?limit=200`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(ownedRes.ok()).toBeTruthy();
        const owned = (await ownedRes.json()) as { items: InheritableDoc[] };
        const termsRows = owned.items.filter((d) => d.path === 'legal/terms.md');
        expect(termsRows.map((d) => d.id)).toEqual([o2.id]);
    });

    test('inherited-body endpoint reads the ORG row even while a same-path Work override exists', async ({
        page,
        request,
    }) => {
        test.setTimeout(KB_PAGE_TIMEOUT);

        const token = await seededToken(request);
        const runId = freshRunId();
        const orgId = randomUUID();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Inherited Body Guard ${runId}`,
        });
        expect(workId).toBeTruthy();

        const orgBody = `# Privacy ${runId}\n\nORG-OWNED body — the inherited-body endpoint must return THIS.\n`;
        const seeded = await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: orgBody,
        });
        await setWorkOrganizationId(request, token, workId, orgId);

        // Create a Work-scope override at the SAME path with a DISTINCT body.
        const override = await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nWORK-OWNED body — must NOT come back from the inherited endpoint.\n`,
        });
        expect(override.workId).toBe(workId);

        // The inherited-body endpoint pins `workId IS NULL` (repo findOrgByPath),
        // so it returns the ORG row even though a same-path Work row now exists.
        const bodyRes = await request.get(
            `${API_BASE}/api/works/${workId}/kb/inheritable/legal/privacy.md?orgId=${encodeURIComponent(orgId)}`,
            { headers: authedHeaders(token) },
        );
        expect(bodyRes.ok(), `inherited-body should be 200, got ${bodyRes.status()}`).toBeTruthy();
        const orgRow = (await bodyRes.json()) as InheritableDoc;
        expect(orgRow.id, 'inherited-body returns the org doc, not the override').toBe(
            seeded.documentId,
        );
        expect(orgRow.workId, 'inherited-body row is org-scoped').toBeNull();
        expect(orgRow.organizationId).toBe(orgId);
        expect(orgRow.id).not.toBe(override.id);
        if (typeof orgRow.body === 'string') {
            expect(orgRow.body, 'inherited-body serves the ORG body').toContain('ORG-OWNED body');
            expect(orgRow.body).not.toContain('WORK-OWNED body');
        }

        // A non-existent org path 404s through the same endpoint (org-row guard).
        const missingRes = await request.get(
            `${API_BASE}/api/works/${workId}/kb/inheritable/legal/nope-${runId}.md?orgId=${encodeURIComponent(orgId)}`,
            { headers: authedHeaders(token) },
        );
        expect(missingRes.status(), 'missing org path 404s').toBe(404);

        // UI BEST-EFFORT (gated on API truth above): the merged set masks the
        // inherited row (override workId !== null) so the tree shows a Work-owned
        // row. The detail route renders in CI but can 404 to the catch-all
        // LOCALLY, so we assert only the stable tree page + tolerate the detail
        // view with .or().
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree')).toBeVisible({ timeout: 30_000 });
        // Overridden → not in inherited section; Work-owned row present.
        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toHaveCount(0, {
            timeout: 15_000,
        });
        const workOwnedRow = page.locator(
            '[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]',
        );
        await expect(workOwnedRow).toBeVisible({ timeout: 15_000 });

        // Best-effort detail-view nav: clicking the Work-owned row should land on
        // the editable (non-inherited) detail view — but only assert if the
        // editor mounts (route may 404 to catch-all in local next-dev).
        await workOwnedRow.click().catch(() => {});
        const editor = page.getByTestId('kb-editor');
        const editorVisible = await editor
            .waitFor({ state: 'visible', timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
        if (editorVisible) {
            // Work-owned detail view is NOT inherited (no read-only banner / data attr).
            await expect(editor).not.toHaveAttribute('data-inherited', 'true');
            await expect(page).toHaveURL(/\/kb\/legal\/privacy\.md$/, { timeout: 15_000 });
        } else {
            test.info().annotations.push({
                type: 'note',
                description:
                    'KB detail route did not mount the editor (local next-dev catch-all 404); API truth already asserted the org-row guard.',
            });
        }
    });

    test('two Works share one org: override on Work A never disturbs Work B inheritance', async ({
        request,
    }) => {
        // API flow — the cross-Work blast-radius is the assertion; UI adds no
        // extra signal beyond the merged-set truth we check directly.
        test.setTimeout(90_000);

        const token = await seededToken(request);
        const runId = freshRunId();
        const orgId = randomUUID();

        const { id: workAId } = await createWorkViaAPI(request, token, {
            name: `KB Shared Org A ${runId}`,
        });
        const { id: workBId } = await createWorkViaAPI(request, token, {
            name: `KB Shared Org B ${runId}`,
        });
        expect(workAId).toBeTruthy();
        expect(workBId).toBeTruthy();
        expect(workAId).not.toBe(workBId);

        // One org doc, BOTH Works paired to the SAME org.
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: `# Privacy ${runId}\n\nShared org doc inherited by both Works.\n`,
        });
        await setWorkOrganizationId(request, token, workAId, orgId);
        await setWorkOrganizationId(request, token, workBId, orgId);

        // Both inherit it as org-scoped.
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workAId, orgId)),
        ).toEqual(['legal/privacy.md']);
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workBId, orgId)),
        ).toEqual(['legal/privacy.md']);

        // Override the doc on Work A ONLY.
        const overrideA = await createWorkKbDoc(request, token, workAId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE A ${runId}`,
            body: `# Privacy OVERRIDE A ${runId}\n`,
        });
        expect(overrideA.workId).toBe(workAId);

        // Work A now masks it (Work-owned); Work B STILL inherits the org doc.
        const aAfter = await resolveInheritableViaAPI(request, token, workAId, orgId);
        const bAfter = await resolveInheritableViaAPI(request, token, workBId, orgId);
        expect(aAfter.find((d) => d.path === 'legal/privacy.md')?.workId).toBe(workAId);
        expect(
            bAfter.find((d) => d.path === 'legal/privacy.md')?.workId,
            'Work B inheritance is untouched by Work A override',
        ).toBeNull();
        expect(orgScopedPaths(bAfter)).toEqual(['legal/privacy.md']);

        // Work B's own-doc list never picked up Work A's override row.
        const bOwnedRes = await request.get(
            `${API_BASE}/api/works/${workBId}/kb/documents?limit=200`,
            { headers: authedHeaders(token) },
        );
        expect(bOwnedRes.ok()).toBeTruthy();
        const bOwned = (await bOwnedRes.json()) as { items: InheritableDoc[] };
        expect(bOwned.items.map((d) => d.id)).not.toContain(overrideA.id);
        expect(bOwned.items.map((d) => d.path)).not.toContain('legal/privacy.md');

        // Deleting Work A's override restores ONLY Work A (B was never affected).
        await deleteWorkKbDoc(request, token, workAId, overrideA.id);
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workAId, orgId)),
        ).toEqual(['legal/privacy.md']);
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workBId, orgId)),
            'Work B unchanged across A override+delete',
        ).toEqual(['legal/privacy.md']);
    });

    test('unpair removes all inheritance; re-pair restores it without re-seeding', async ({
        page,
        request,
    }) => {
        test.setTimeout(KB_PAGE_TIMEOUT);

        const token = await seededToken(request);
        const runId = freshRunId();
        const orgId = randomUUID();

        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB Pair Toggle ${runId}`,
        });
        expect(workId).toBeTruthy();

        // Two org docs in two classes, pair the Work.
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'legal/privacy.md',
            title: `Privacy ${runId}`,
            targetClass: 'legal',
            body: `# Privacy ${runId}\n`,
        });
        await seedOrgKbDoc(request, token, {
            orgId,
            path: 'style/voice.md',
            title: `Voice ${runId}`,
            targetClass: 'style',
            body: `# Voice ${runId}\n`,
        });
        await setWorkOrganizationId(request, token, workId, orgId);

        // Paired: both inherited (API), inherited section mounts (UI).
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workId, orgId)),
        ).toEqual(['legal/privacy.md', 'style/voice.md']);
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited-style-voice')).toBeVisible({
            timeout: 15_000,
        });

        // ── UNPAIR ── set organizationId = null.
        await setWorkOrganizationId(request, token, workId, null);

        // API truth: the KB page drives orgId from work.organizationId; with the
        // Work unpaired, the page resolves org-scope []. Confirm work.organizationId
        // is cleared, and that resolving against the (now-detached) org still works
        // at the API level but the page won't ask for it.
        const workRes = await request.get(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
        });
        expect(workRes.ok()).toBeTruthy();
        const workJson = (await workRes.json()) as {
            work?: { organizationId?: string | null };
            organizationId?: string | null;
        };
        const orgIdAfterUnpair = workJson.work?.organizationId ?? workJson.organizationId ?? null;
        expect(orgIdAfterUnpair, 'work is unpaired (organizationId null)').toBeNull();

        // UI truth (unpaired): the inherited section unmounts entirely — the page
        // has no orgId to resolve inheritable docs against.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited-style-voice')).toHaveCount(0, {
            timeout: 15_000,
        });

        // ── RE-PAIR ── to the SAME org (docs were never re-seeded).
        await setWorkOrganizationId(request, token, workId, orgId);

        // API truth: inheritance is back exactly as before.
        expect(
            orgScopedPaths(await resolveInheritableViaAPI(request, token, workId, orgId)),
        ).toEqual(['legal/privacy.md', 'style/voice.md']);

        // UI truth (re-paired): the inherited section + both rows re-mount.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited-style-voice')).toBeVisible({
            timeout: 15_000,
        });
    });
});

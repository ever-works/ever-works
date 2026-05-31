import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { seedOrgKbDoc, setWorkOrganizationId } from './helpers/kb-fixtures';

/**
 * Knowledge Base — inherited-doc OVERRIDE matrix (EW-641 Phase 2/e, #1192).
 *
 * Complex, multi-entity orchestration of the org→Work KB inheritance +
 * override resolution path. Each flow seeds org-scope inheritable docs,
 * pairs a Work with the org, creates Work-scope overrides at the SAME
 * path, and asserts the OBSERVABLE effect on both the resolution API
 * (`GET /works/:id/kb/inheritable`) and the rendered tree UI
 * (`KbTreePanel`'s "Inherited from organization" section).
 *
 * The core behaviour under test is the #1192 `doc.workId === null` filter
 * in `KbTreePanel` (apps/web/.../kb/KbTreePanel.tsx): the inheritable
 * endpoint returns the MERGED effective set (`resolveInheritableDocuments`
 * — org docs keyed by path, Work overrides shadowing org docs at the same
 * path), so once a Work overrides an inherited doc, that path comes back
 * as a Work-OWNED row (`workId !== null`). The UI inherited section must
 * EXCLUDE those — the overridden copy now lives in the per-class Work
 * group instead.
 *
 * ───────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE
 * WRITING (register → work → 2 org docs → pair → override → re-resolve):
 *
 *   POST /api/auth/register                          -> { access_token, user } (username >= 3 chars)
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
 *            => orgScoped (workId === null) count == 0  => UI inherited section unmounts
 *   POST /api/works/:id/kb/documents                 -> 201 KbDocumentBodyDto
 *        { id, workId:<workId>, organizationId:null, path, slug, ... }  (Work-scope override)
 *   GET  /api/works/:id/kb/documents?limit=200       -> { items:KbDocumentDto[], total } (Work-owned only)
 *
 *   ISOLATION: the inheritable endpoint TRUSTS the `orgId` query param — it
 *   does not re-verify the Work belongs to that org. The KB page server
 *   component (kb/page.tsx) drives `orgId` from `work.organizationId`, so a
 *   Work paired with a DIFFERENT (empty) org resolves `[]` and never shows
 *   org-A's docs. The isolation flow models exactly that: Work B is paired
 *   with its own org B, which has no docs, so org A's inherited docs never
 *   surface in Work B's inherited section.
 *
 * UI selectors verified against real source (KbTreePanel.tsx / KbTreeDocRow.tsx /
 * KbShell.tsx):
 *   - kb-shell                              (data-work-id)
 *   - kb-tree                               (panel) / kb-tree-count (Work-owned count)
 *   - kb-tree-inherited                     ("Inherited from organization" section; only
 *                                            mounts when >=1 org-scoped doc remains)
 *   - kb-tree-inherited-description
 *   - kb-tree-inherited-<class>-<slug>      inherited row; data-source="inherited",
 *                                            data-doc-path, data-doc-class
 *   - kb-tree-item  (data-doc-path)         Work-owned row (used by override + group)
 *   - kb-tree-group-<class>                 per-class Work-owned group
 *
 * ───────────────────────────────────────────────────────────────────────
 * DEVIATIONS / NOTES:
 *   - `/api/organizations/:orgId/kb/documents` does not enforce org
 *     membership today (controller docstring), so we mint a random UUID for
 *     each org and skip seeding an `Organization` row — mirrors the existing
 *     kb-inherited.spec.ts approach.
 *   - The seeded user (storageState) owns the Works so the UI's logged-in
 *     user matches the API mutations: we log in via API for the seeded
 *     user's bearer token and run ALL setup through it. This is read-heavy
 *     KB inheritance state that doesn't shadow chat/provider settings, so it
 *     is safe on the shared user (no per-user apiKey is touched).
 *   - Unique org UUIDs + run-id-suffixed slugs keep these flows isolated
 *     from sibling specs and from each other; assertions use toContain /
 *     per-row testids, never global counts that other specs could perturb.
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
    test('partial override: overridden doc leaves the inherited section, others stay inherited', async ({
        page,
        request,
    }) => {
        // First KB-page hit triggers Next dev-mode compilation; budget like
        // the other authenticated KB specs.
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
        const orgId = randomUUID();

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

        // 6. UI truth (pre-override): both inherited rows present in the section.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        const inheritedSection = page.getByTestId('kb-tree-inherited');
        await expect(inheritedSection).toBeVisible({ timeout: 30_000 });

        const privacyRow = page.getByTestId('kb-tree-inherited-legal-privacy');
        const termsRow = page.getByTestId('kb-tree-inherited-legal-terms');
        await expect(privacyRow).toBeVisible({ timeout: 15_000 });
        await expect(termsRow).toBeVisible({ timeout: 15_000 });
        await expect(privacyRow).toHaveAttribute('data-source', 'inherited');
        await expect(privacyRow).toHaveAttribute('data-doc-path', 'legal/privacy.md');
        await expect(termsRow).toHaveAttribute('data-doc-path', 'legal/terms.md');

        // 7. Create a WORK-scope override of legal/privacy.md (same path).
        const override = await createWorkKbDoc(request, token, workId, {
            path: 'legal/privacy.md',
            title: `Privacy OVERRIDE ${runId}`,
            body: `# Privacy OVERRIDE ${runId}\n\nWork-scope override of the org privacy policy.\n`,
        });
        expect(override.workId, 'override must be Work-scoped').toBe(workId);
        expect(override.organizationId, 'override must not carry an org id').toBeNull();
        expect(override.path).toBe('legal/privacy.md');

        // 8. API truth (post-partial-override): the merged set now returns
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

        // 9. UI truth (post-partial-override): reload the tree. The overridden
        //    privacy row is GONE from the inherited section (workId !== null
        //    filtered out by KbTreePanel), terms remains inherited, and the
        //    overridden privacy now appears as a Work-owned tree item.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });

        await expect(page.getByTestId('kb-tree-inherited')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited-legal-terms')).toBeVisible({
            timeout: 15_000,
        });

        // The override surfaces as a Work-owned row at the same path.
        const workOwnedPrivacy = page.locator(
            '[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]',
        );
        await expect(workOwnedPrivacy).toBeVisible({ timeout: 15_000 });
        // And NOT as a Work-owned terms row (terms was never overridden).
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="legal/terms.md"]'),
        ).toHaveCount(0);
    });

    test('full override: inherited section empties while Work owns every former inherited doc', async ({
        page,
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
        const orgId = randomUUID();

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
        const docsRes = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents?limit=200`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(docsRes.ok()).toBeTruthy();
        const docsBody = (await docsRes.json()) as { items: InheritableDoc[]; total: number };
        const ownedPaths = docsBody.items.map((d) => d.path);
        expect(ownedPaths).toContain('legal/privacy.md');
        expect(ownedPaths).toContain('legal/terms.md');
        // Work-owned docs are never org-scoped.
        for (const d of docsBody.items) {
            expect(d.workId, `Work doc ${d.path} must be Work-scoped`).toBe(workId);
        }

        // UI truth: with zero org-scoped docs remaining, KbTreePanel unmounts
        // the entire "Inherited from organization" section (it only renders
        // when orgInheritedDocuments.length > 0). The Work's own docs DO list
        // them under the per-class group.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree')).toBeVisible({ timeout: 30_000 });

        // Inherited section + every inherited row are gone.
        await expect(page.getByTestId('kb-tree-inherited')).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toHaveCount(0);
        await expect(page.getByTestId('kb-tree-inherited-legal-terms')).toHaveCount(0);

        // Both former-inherited docs now render as Work-owned rows under the
        // legal group.
        await expect(page.getByTestId('kb-tree-group-legal')).toBeVisible({ timeout: 15_000 });
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]'),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
            page.locator('[data-testid="kb-tree-item"][data-doc-path="legal/terms.md"]'),
        ).toBeVisible({ timeout: 15_000 });
    });

    test('inheritance isolation: org-A doc inherited by Work A is not inherited by unrelated Work B', async ({
        page,
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
        const orgA = randomUUID();
        const orgB = randomUUID();
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
        // fresh UUID, so this path is exclusively ours).
        const isoPath = `legal/isolation-${runId}.md`;
        const isoSlug = `isolation-${runId}`;
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

        // UI truth — Work A: the inherited section lists the isolation doc.
        await page.goto(`/en/works/${workAId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree-inherited')).toBeVisible({ timeout: 30_000 });
        const isoRowA = page.getByTestId(`kb-tree-inherited-legal-${isoSlug}`);
        await expect(isoRowA).toBeVisible({ timeout: 15_000 });
        await expect(isoRowA).toHaveAttribute('data-doc-path', isoPath);
        await expect(isoRowA).toHaveAttribute('data-source', 'inherited');

        // UI truth — Work B: the isolation doc is NOT shown as inherited.
        // Work B has no org docs at all, so the inherited section never mounts
        // (and certainly not the org-A row).
        await page.goto(`/en/works/${workBId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-tree')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId(`kb-tree-inherited-legal-${isoSlug}`)).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect(page.getByTestId('kb-tree-inherited')).toHaveCount(0, { timeout: 15_000 });
    });
});

import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createWorkViaAPI, loginViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { seedOrgKbDoc, setWorkOrganizationId } from './helpers/kb-fixtures';

/**
 * EW-641 Phase 2/e row 38e — A19 + A20 acceptance e2e.
 *
 * Closes the Phase 2/e inherited-docs surface end-to-end by exercising
 * the full user journey:
 *
 *   A19 (inherited visible)
 *     - Org-scope KB doc seeded at `legal/privacy.md` via the public
 *       `POST /api/organizations/:orgId/kb/documents` endpoint.
 *     - Work paired with that orgId via `PATCH /api/works/:id`
 *       (`organizationId` was added to `UpdateWorkDto` in this PR).
 *     - The Work's KB tree renders an "Inherited from organization"
 *       section with a `kb-tree-inherited-legal-privacy` row that
 *       deep-links to the inherited detail route.
 *     - The detail route renders read-only — KB editor root carries
 *       `data-inherited="true"` and the banner + "Override locally"
 *       CTA are mounted.
 *
 *   A20 (Work override beats org)
 *     - Clicking the override CTA hits the row-38d server action,
 *       clones the inherited doc into Work scope at the same path,
 *       and `router.push`es back to the now-Work-scope detail URL.
 *     - The same URL now renders the editable Tiptap surface
 *       (`kb-editor-body` is contentEditable + the banner is gone +
 *       `data-inherited` is absent).
 *     - On a fresh page load of the tree, the inherited row is no
 *       longer in the inherited section (Work override masks it via
 *       `resolveInheritableDocuments`'s path-collision filter) — the
 *       same slug now appears as a Work-scope tree item instead.
 *
 * Why one shared test for A19 + A20: the override step needs the
 * inherited surface to be live, and exercising both in one spec
 * shares the Work + Org seed cost. Splitting them would double the
 * seed cost and create flakiness windows where A20 starts before
 * A19's fan-out settles.
 *
 * Notes:
 *  - `/api/organizations/:orgId/kb/documents` does not enforce org
 *    membership today (per the controller's docstring); any
 *    authenticated user can post for any orgId. So we mint a random
 *    UUID for the org and skip seeding an `Organization` row.
 *  - The org-doc class is restricted to `legal | style | seo` per
 *    spec D2 (`KB_INHERITABLE_CLASSES`); we use `legal` for parity
 *    with the row-38e handoff plan.
 */

test.describe('Knowledge Base — A19+A20 inherited docs', () => {
    test('inherited row appears, override clones into Work scope, then masks the inherited row', async ({
        page,
        request,
    }) => {
        // Same 180s budget the other authenticated KB specs use — first
        // KB-page hit triggers Next dev-mode compilation, the override
        // CTA chains a server-action roundtrip + a router.push reload.
        test.setTimeout(180_000);

        // 1. Bearer token + fresh Work owned by the seeded test user.
        const testUser = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: testUser.email,
            password: testUser.password,
        });
        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Inherited ${runId}`,
        });
        expect(workId, 'createWorkViaAPI must return a non-empty work id').toBeTruthy();

        // 2. Seed an org-scope KB doc at `legal/privacy.md`. The slug
        //    embedded in the spec selector (`legal-privacy`) must
        //    match `slugFromPath('legal/privacy.md')` = 'privacy'.
        // A REAL organization owned by the seeded user — org-scope KB now
        // enforces tenant ownership (cross-tenant IDOR fix), so a bare random
        // UUID 404s. `randomUUID()` only supplies a collision-proof name.
        const orgId = (await createOrganizationViaAPI(request, access_token, `kb-org-${randomUUID()}`))
            .id;
        const docTitle = `Privacy ${runId}`;
        const docBody = `# ${docTitle}\n\nOrganization privacy policy — inherited by every paired Work.\n`;
        await seedOrgKbDoc(request, access_token, {
            orgId,
            path: 'legal/privacy.md',
            title: docTitle,
            targetClass: 'legal',
            body: docBody,
        });

        // 3. Pair the Work with the org. After this, the
        //    `/works/:id/kb/inheritable?orgId=...` endpoint surfaces the
        //    seeded doc, and the KB page's parallel fetch picks it up
        //    via `kbAPI.listInheritableDocuments` (row 38b).
        await setWorkOrganizationId(request, access_token, workId, orgId);

        // 3b. Warm-compile the dynamic KB *detail* route up front. The inherited
        //     row below is a client-side <Link> to `/kb/legal/privacy.md`; on a
        //     cold `next dev` that route's first compile is 15s+, which raced
        //     the post-click URL wait under load (the click registered but the
        //     URL hadn't flipped). Paying the compile here (it falls back to the
        //     inherited-body endpoint pre-override) makes the later navigation
        //     fast and deterministic.
        await page
            .goto(`/en/works/${workId}/kb/legal/privacy.md`, { waitUntil: 'domcontentloaded' })
            .catch(() => undefined);

        // 4. Open the KB page and assert the inherited row is in the
        //    "Inherited from organization" section, with the lock
        //    marker + the expected `data-source="inherited"` data attr.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });

        const inheritedSection = page.getByTestId('kb-tree-inherited');
        await expect(inheritedSection).toBeVisible({ timeout: 30_000 });

        const inheritedRow = page.getByTestId('kb-tree-inherited-legal-privacy');
        await expect(inheritedRow).toBeVisible({ timeout: 15_000 });
        await expect(inheritedRow).toHaveAttribute('data-source', 'inherited');
        await expect(inheritedRow).toHaveAttribute('data-doc-path', 'legal/privacy.md');

        // 5. Navigate to the inherited detail route. The page falls
        //    back to the inherited body endpoint when the Work-scope
        //    lookup 404s (row 38c-2), so the same URL serves both
        //    Work-scope and inherited views — the difference is the
        //    `data-inherited="true"` attribute + the banner.
        // The inherited row is a Next.js <Link> (<a href>). Clicking it kicks
        // off a client-side navigation that must cold-compile the
        // `/kb/legal/privacy.md` dynamic detail route in `next dev` — the
        // first hit can take 15s+ on its own, so the old 15s `toHaveURL` had
        // no headroom and flaked (the click registered — the row showed as
        // `[active]` in the failure snapshot — but the URL hadn't flipped yet).
        // `waitForURL` is the canonical navigation-wait primitive; give it the
        // same cold-compile budget the config reserves for first-hit routes,
        // then settle the network before asserting on the rendered editor.
        await inheritedRow.click();
        await page.waitForURL(/\/kb\/legal\/privacy\.md$/, { timeout: 60_000 });
        await page.waitForLoadState('domcontentloaded');
        await expect(page).toHaveURL(/\/kb\/legal\/privacy\.md$/, { timeout: 15_000 });

        const editorRoot = page.getByTestId('kb-editor');
        await expect(editorRoot).toBeVisible({ timeout: 30_000 });
        await expect(editorRoot).toHaveAttribute('data-inherited', 'true');

        const banner = page.getByTestId('kb-inherited-banner');
        await expect(banner).toBeVisible({ timeout: 10_000 });
        // Lock marker emoji is rendered inside the banner-icon span.
        await expect(page.getByTestId('kb-inherited-banner-icon')).toContainText('🔒');

        const overrideCta = page.getByTestId('kb-inherited-override-cta');
        await expect(overrideCta).toBeVisible();
        await expect(overrideCta).toBeEnabled();

        // 6. Click the override CTA. The row-38d server action reads
        //    the inherited body, POSTs a clone to Work scope, then
        //    `router.push`es to the new doc — which lives at the same
        //    path, so the URL doesn't change, but the page re-renders
        //    as Work-scope (banner gone, contentEditable Tiptap up).
        await overrideCta.click();

        // After the transition flips `isPending`, the banner unmounts
        // (because the page re-fetched and the doc is no longer
        // inherited) and the editable Tiptap surface appears. We
        // tolerate either order — the banner may briefly stay
        // mounted during the transition.
        //
        // The override chains a server-action roundtrip (read inherited body →
        // clone POST into Work scope) + a `router.push` that re-fetches and
        // re-renders the now-Work-scope view. In `next dev` the editable Tiptap
        // surface may also cold-compile on first mount, so 30s left no headroom
        // and flaked with the banner still mounted. This is a web-first
        // auto-retrying assertion — widen the budget to the cold-compile
        // ceiling the config reserves for first-hit routes.
        await expect(banner).not.toBeVisible({ timeout: 60_000 });

        // The Work-scope view drops the `data-inherited` attribute
        // entirely (the prop defaults to false on KbDocumentView).
        // Wait for that to be reflected in the DOM.
        await expect(editorRoot).not.toHaveAttribute('data-inherited', 'true', {
            timeout: 30_000,
        });

        // The KbEditor body is mounted with `contentEditable` set —
        // that's the canonical signal a user can now edit the doc.
        const editorBody = page.getByTestId('kb-editor-body');
        await expect(editorBody).toBeVisible({ timeout: 30_000 });
        await expect(editorBody).toHaveAttribute('contenteditable', 'true');

        // 7. Reload the tree and assert the override masks the
        //    inherited row. The inherited section either disappears
        //    entirely (the only inheritable doc is now overridden) or
        //    the privacy row is gone from it; in both cases the
        //    `kb-tree-inherited-legal-privacy` selector must NOT
        //    match anymore. A Work-scope row at the same path takes
        //    over (`kb-tree-item` with `data-doc-path="legal/privacy.md"`).
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });

        await expect(page.getByTestId('kb-tree-inherited-legal-privacy')).toHaveCount(0, {
            timeout: 15_000,
        });
        const workScopeRow = page.locator(
            '[data-testid="kb-tree-item"][data-doc-path="legal/privacy.md"]',
        );
        await expect(workScopeRow).toBeVisible({ timeout: 15_000 });
    });
});

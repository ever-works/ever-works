import { test, expect } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createWorkViaAPI, loginViaAPI } from './helpers/api';

/**
 * EW-641 Phase 1B/d row 19 — A12 acceptance e2e.
 *
 * Drives a real user-visible KB upload end-to-end: logs in via API to
 * grab a bearer token, POSTs a fresh Work, navigates to the new Work's
 * KB page in the authenticated chromium context (storageState from
 * global-setup), drops a markdown file onto the upload zone via the
 * hidden `<input type=file>` behind it (per Playwright's
 * file-upload-download pattern — no OS-level drag simulation needed),
 * confirms the classify modal, and waits for both (a) the upload entry
 * to reach `data-status="succeeded"` and (b) the new doc to appear in
 * the server-rendered tree panel.
 *
 * Selectors:
 *  - `kb-shell` — KB page root (KbShell.tsx)
 *  - `kb-upload-input` — `sr-only` file input the zone forwards browse
 *    clicks to (KbUploadZone.tsx)
 *  - `kb-classify-modal`, `kb-classify-class`, `kb-classify-confirm` —
 *    KbClassifyModal.tsx
 *  - `kb-upload-entry[data-status]` — KbUploadZone status row
 *  - `kb-tree-item[data-doc-path]` — KbTreePanel.tsx leaf link
 *
 * Lives in `apps/web/e2e/` so the existing `e2e.yml` workflow picks it
 * up on push to develop / stage / main. NOT picked up by the
 * `chromium-no-auth` project (its `testMatch` regex enumerates specific
 * unauth specs — `kb-*` is not in it).
 */

test.describe('Knowledge Base — A12 drag-drop upload', () => {
    test('uploading a markdown file creates a new doc visible in the tree', async ({
        page,
        request,
    }) => {
        // First-hit dashboard routes hit Next.js dev-mode compilation
        // (~10-15s each). The KB page + classify modal + upload roundtrip
        // chain three of those, so give the spec the same 180s budget the
        // suite uses for navigation-heavy authenticated flows.
        test.setTimeout(180_000);

        // 1. Mint a bearer token for the same user the storageState
        //    was signed in as. We can't pull it out of cookies here —
        //    the web's session cookie is opaque — so re-login via
        //    /api/auth. Importing `TEST_USER` directly from
        //    `helpers/test-user.ts` is unsafe across spec workers
        //    because each Node process re-evaluates the module's
        //    `Date.now()` suffix; the global-setup project writes the
        //    real credentials to disk and `loadSeededTestUser()` reads
        //    them back.
        const testUser = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: testUser.email,
            password: testUser.password,
        });

        // 2. Create a fresh Work for this run so the KB tree starts
        //    empty. Each call uses Date.now() + a random tail so parallel
        //    workers don't collide on the slug.
        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Upload ${runId}`,
        });
        expect(workId, 'createWorkViaAPI must return a non-empty work id').toBeTruthy();

        // 3. Navigate to the KB page for this Work.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-shell')).toBeVisible({ timeout: 60_000 });

        // 4. Drop the markdown buffer onto the upload zone's hidden input.
        //    The zone keeps an `<input type=file>` with `sr-only` styling
        //    behind the visible drop target; `setInputFiles` works on it
        //    directly, no `dataTransfer` synthesis needed (Playwright
        //    best practice: file-upload-download.md).
        const uploadInput = page.getByTestId('kb-upload-input');
        const fileName = `kb-e2e-${runId}.md`;
        const fileBuffer = Buffer.from(
            `# KB e2e ${runId}\n\nFirst content of the doc — uploaded by A12.\n`,
            'utf8',
        );
        await uploadInput.setInputFiles({
            name: fileName,
            mimeType: 'text/markdown',
            buffer: fileBuffer,
        });

        // 5. Classify modal opens — default class is 'freeform'; keep it
        //    so we land in a predictable group in the tree. 'knowledge' is
        //    NOT a valid KbDocumentClass enum value (the schema is brand |
        //    legal | seo | style | glossary | competitors | personas |
        //    research | output | freeform). Leave description blank and
        //    tags empty; row 20 (A13) covers edit+autosave separately.
        const modal = page.getByTestId('kb-classify-modal');
        await expect(modal).toBeVisible({ timeout: 15_000 });
        await page.getByTestId('kb-classify-class').selectOption('freeform');
        await page.getByTestId('kb-classify-confirm').click();
        // After confirm the modal unmounts.
        await expect(modal).not.toBeVisible({ timeout: 10_000 });

        // 6. The upload entry should reach `data-status="succeeded"` once
        //    the multipart POST + extraction + commit roundtrip lands.
        const succeededEntry = page.locator(
            '[data-testid="kb-upload-entry"][data-status="succeeded"]',
        );
        await expect(succeededEntry).toBeVisible({ timeout: 60_000 });

        // 7. router.refresh() (inside KbUploadZone's onSuccess) re-fetches
        //    the server-rendered tree panel. The new doc has a path under
        //    `freeform/<slug>.md` derived from the title (filename minus
        //    extension), so we match by `data-doc-path*="<runId>"`.
        const treeItem = page.locator(`[data-testid="kb-tree-item"][data-doc-path*="${runId}"]`);
        await expect(treeItem).toBeVisible({ timeout: 30_000 });
    });
});

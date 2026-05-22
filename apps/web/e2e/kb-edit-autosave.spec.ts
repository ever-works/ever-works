import { test, expect } from '@playwright/test';
import { TEST_USER } from './helpers/test-user';
import { createWorkViaAPI, loginViaAPI } from './helpers/api';
import { seedKbMarkdownDoc } from './helpers/kb-fixtures';

/**
 * EW-641 Phase 1B/d row 20 — A13 acceptance e2e (edit + autosave).
 *
 * Seeds a KB markdown doc via the public API (`POST /api/works/:id/kb/uploads`,
 * synchronous create for text MIMEs per spec §7.4), navigates to the per-doc
 * editor route (`/en/works/<id>/kb/<path>`), focuses Tiptap's contentEditable
 * surface, appends a marker substring, waits for the autosave status pill to
 * land on `saved`, then reloads the page and asserts the appended substring
 * is still in the editor body — proving end-to-end persistence.
 *
 * Selectors:
 *  - `kb-editor` — KbEditor root (KbEditor.tsx)
 *  - `kb-editor-status[data-status]` — autosave status pill (`idle | dirty |
 *    saving | saved | error`)
 *  - `[data-testid="kb-editor"] [contenteditable="true"]` — Tiptap's
 *    ProseMirror surface. We resolve it through `kb-editor` because the
 *    `kb-editor-body` testid is currently scoped to the placeholder (the
 *    EditorContent wrapper drops it once Tiptap mounts) — using the
 *    contentEditable attribute makes the test stable across mounted /
 *    unmounted states without touching production code.
 *
 * The KB editor autosave debounce is 1500ms (see KbEditor.tsx's
 * `autosaveDebounceMs`), so the `saved` assertion budgets 10s.
 *
 * Lives in `apps/web/e2e/` so the existing `e2e.yml` workflow picks it up
 * on push to develop / stage / main. Skipped by the `chromium-no-auth`
 * project (the `testMatch` regex enumerates specific unauth specs —
 * `kb-*` is not in it).
 */

test.describe('Knowledge Base — A13 edit + autosave', () => {
    test('appended text autosaves and survives a reload', async ({ page, request }) => {
        // Mirrors the row-19 (A12) timing budget. First-hit dashboard +
        // KB nested route + editor mount each pay the Next.js dev-mode
        // compile cost, then autosave debounces + commits.
        test.setTimeout(180_000);

        // 1. Mint a bearer token for the test user.
        const { access_token } = await loginViaAPI(request, {
            email: TEST_USER.email,
            password: TEST_USER.password,
        });

        // 2. Create a fresh Work and seed one markdown doc inside it via
        //    the API (no UI driving). The seeded doc lives at
        //    `knowledge/<slug>.md` because we pass `targetClass: knowledge`.
        const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Autosave ${runId}`,
        });
        expect(workId, 'createWorkViaAPI must return a non-empty work id').toBeTruthy();

        const seedBody = `# A13 seed ${runId}\n\nInitial body before the edit.\n`;
        const { path: docPath } = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `kb-a13-${runId}.md`,
            body: seedBody,
        });
        expect(docPath).toMatch(/\.md$/);

        // 3. Navigate to the per-doc editor route.
        await page.goto(`/en/works/${workId}/kb/${docPath}`, { waitUntil: 'domcontentloaded' });
        const editor = page.getByTestId('kb-editor');
        await expect(editor).toBeVisible({ timeout: 60_000 });

        // Status pill should start at `idle` (or `saved` if the editor's
        // initial-content effect briefly flipped it). Wait for the
        // contentEditable surface to be ready before typing.
        const editable = page.locator('[data-testid="kb-editor"] [contenteditable="true"]').first();
        await expect(editable).toBeVisible({ timeout: 30_000 });

        // 4. Focus the editor and append a uniquely-identifiable marker.
        await editable.click();
        // Move the caret to the end of the document before typing so we
        // don't overwrite the seed heading.
        await page.keyboard.press('Control+End');
        const marker = `A13-marker-${runId}`;
        // Newline first so the marker lands on its own paragraph, then
        // the marker text. `keyboard.type` simulates real key events,
        // which Tiptap binds onto via ProseMirror's input rules.
        await page.keyboard.type(`\n${marker}\n`);

        // 5. Autosave debounce is 1500ms; allow 10s including a network
        //    round-trip on the slow CI runner.
        const status = page.getByTestId('kb-editor-status');
        await expect(status).toHaveAttribute('data-status', 'saved', { timeout: 10_000 });

        // 6. Reload the page. The editor remounts and re-fetches the
        //    persisted markdown — the marker must still be there.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-editor')).toBeVisible({ timeout: 60_000 });
        const reloadedEditable = page
            .locator('[data-testid="kb-editor"] [contenteditable="true"]')
            .first();
        await expect(reloadedEditable).toBeVisible({ timeout: 30_000 });
        await expect(reloadedEditable).toContainText(marker, { timeout: 15_000 });
    });
});

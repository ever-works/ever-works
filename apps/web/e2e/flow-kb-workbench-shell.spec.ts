import { test, expect, type APIRequestContext } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { seedKbMarkdownDoc } from './helpers/kb-fixtures';

/**
 * EW-641 slice A — KB workbench shell acceptance.
 *
 * Drives the slice-A workbench surface end-to-end through the real
 * authenticated UI:
 *   - Index page `/{locale}/works/:id/kb` shows the empty-state in the
 *     centre pane and the tree on the left.
 *   - Catch-all `/{locale}/works/:id/kb/{...path}` swaps the centre pane
 *     for `KbDocumentHeader` + the Tiptap WYSIWYG editor and pre-highlights
 *     the active row.
 *   - The Tiptap contenteditable + 800 ms debounced autosave actually
 *     persists to the API; a reload re-reads the same body.
 *   - The header class chip + lock badge render from the doc DTO.
 *
 * Auth: uses the shared seeded user (via `loadSeededTestUser` +
 * `loginViaAPI` for API seeding, and the `storageState` cookie for the
 * browser context — same pattern as `flow-kb-document-lifecycle.spec.ts`
 * flow 1) so the Work it creates is visible to the UI session.
 *
 * Skip-gate (`KB_E2E_LIVE`): the workbench fixture pipeline talks to the
 * real `/api/works/:id/kb/uploads` + `/api/works/:id/kb/documents/:id`
 * endpoints to seed docs, lock one, and autosave a body edit. In CI the
 * in-memory sqlite env serves all of those (no external storage, no
 * Trigger.dev, no ffmpeg needed), so by default the describe runs
 * unconditionally. If a future CI matrix point loses the in-memory API
 * (k8s-only env, mocked-API env, etc.) operators can flip
 * `KB_E2E_LIVE_SKIP=1` to opt out — `KB_E2E_LIVE` is a positive flag
 * elsewhere (reconciliation/upload-retry require it), so we follow the
 * same naming and use a `_SKIP` companion for the rare opt-out path.
 * That keeps this spec green in default CI while still giving operators
 * a one-line escape hatch when the API is not reachable from the
 * Playwright worker.
 */

const KB_E2E_LIVE_SKIP = process.env.KB_E2E_LIVE_SKIP === '1';

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface LockResponse {
    locked: boolean;
    lockMode: string | null;
}

async function lockDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
    mode: 'full' | 'additions-only',
): Promise<LockResponse> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents/${docId}/lock`, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: { mode },
    });
    if (!res.ok()) {
        throw new Error(`lockDoc failed (${res.status()}): ${await res.text()}`);
    }
    return (await res.json()) as LockResponse;
}

interface DocBody {
    id: string;
    body: string;
}

async function fetchDocBody(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
): Promise<DocBody> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) {
        throw new Error(`fetchDocBody failed (${res.status()}): ${await res.text()}`);
    }
    return (await res.json()) as DocBody;
}

test.describe('KB workbench shell — slice A', () => {
    test.beforeEach(() => {
        test.skip(
            KB_E2E_LIVE_SKIP,
            'KB_E2E_LIVE_SKIP=1: the workbench fixture pipeline requires a reachable in-process API (POST /kb/uploads + PATCH /kb/documents). Unset to run.',
        );
    });

    test('workbench loads with tree visible and empty-state centre pane', async ({
        page,
        request,
    }) => {
        // First-hit dashboard route compiles in Next.js dev mode; budget
        // for the cold compile + tree fetch.
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Workbench Empty ${id}`,
        });

        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('kb-workbench-left')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-tree')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-empty')).toBeVisible();
    });

    test('clicking a tree row routes to the doc, header + editor render the body', async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Workbench Multi-Class ${id}`,
        });

        // Seed three docs across three classes so the tree shows multiple
        // groups (brand / style / research). The workbench tree groups
        // by class and the active class auto-expands.
        const brandBody = `# Brand voice ${id}\n\nWe write plainly.\n`;
        const brand = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `brand-voice-${id}.md`,
            body: brandBody,
            targetClass: 'brand',
        });
        await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `style-guide-${id}.md`,
            body: `# Style ${id}\n\nUse the Oxford comma.\n`,
            targetClass: 'style',
        });
        await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `research-notes-${id}.md`,
            body: `# Research ${id}\n\nMarket scan.\n`,
            targetClass: 'research',
        });

        // Land on the index page so we can click the tree row and assert
        // the resulting URL transition.
        await page.goto(`/en/works/${workId}/kb`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-shell')).toBeVisible({ timeout: 60_000 });

        // The brand group is collapsed by default on the index page (no
        // active doc), so expand it first, then click the brand row.
        await page.getByTestId('kb-workbench-group-toggle-brand').click();
        const row = page.locator(`[data-testid="kb-workbench-row-${brand.documentId}"]`);
        await expect(row).toBeVisible();
        await row.click();

        // URL transitions to the catch-all path.
        await page.waitForURL((url) => url.pathname.endsWith(`/works/${workId}/kb/${brand.path}`), {
            timeout: 30_000,
        });

        // Header chip + editor render with the seeded body.
        await expect(page.getByTestId('kb-workbench-document-header')).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('kb-workbench-class-chip')).toHaveAttribute(
            'data-kb-class',
            'brand',
        );
        // The editor is a Tiptap contenteditable, not a textarea: it
        // renders the seeded Markdown as rich text, so assert on the
        // VISIBLE heading text (`# Brand voice <id>` → "Brand voice <id>")
        // rather than the raw Markdown string.
        const editorBody = page.getByTestId('kb-tiptap-editor-body');
        await expect(editorBody).toBeVisible();
        await expect(editorBody).toContainText(`Brand voice ${id}`);
        await expect(editorBody).toContainText('We write plainly.');
    });

    test('editor edit autosaves and persists across reload', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Workbench Autosave ${id}`,
        });
        const seedBody = `# Autosave ${id}\n\noriginal body\n`;
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `autosave-${id}.md`,
            body: seedBody,
            targetClass: 'brand',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        // The editor is a Tiptap contenteditable (`kb-tiptap-editor-body`),
        // NOT a textarea — it renders the seeded Markdown as rich text, so
        // assert on the visible body text rather than a `.toHaveValue()`.
        const editorBody = page.getByTestId('kb-tiptap-editor-body');
        await expect(editorBody).toBeVisible({ timeout: 60_000 });
        await expect(editorBody).toContainText(`Autosave ${id}`);
        await expect(editorBody).toContainText('original body');

        // Type a distinct marker the API poll below can pin against.
        // Click into the contenteditable, jump to the very end, and type
        // the marker on a fresh line. Tiptap serialises this back to
        // Markdown on the `update` event and schedules the debounced
        // autosave.
        const marker = `Autosaved marker ${id}`;
        await editorBody.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.press('Enter');
        await page.keyboard.type(marker);

        // The marker should render in the contenteditable immediately.
        await expect(editorBody).toContainText(marker);

        // Editor debounces autosave at 800 ms; wait the spec-mandated 1.5 s
        // for the save to start and land, then poll the persisted body via
        // the API (cheaper + less flaky than waiting on the inline status
        // chip which is sr-only when idle). Tiptap round-trips through
        // Markdown so whitespace/formatting can shift — assert the
        // persisted body CONTAINS the marker rather than exact-equality.
        await page.waitForTimeout(1_500);
        await expect
            .poll(
                async () => {
                    const fresh = await fetchDocBody(request, access_token, workId, doc.documentId);
                    return fresh.body;
                },
                {
                    message: 'autosave should persist the marker within ~5s of the debounce',
                    timeout: 5_000,
                    intervals: [200, 500, 1_000],
                },
            )
            .toContain(marker);

        // Reload + reassert the editor was rehydrated from the server copy
        // — proves the persisted body round-trips through the page load and
        // back into the editor's initial content.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-tiptap-editor-body')).toContainText(marker, {
            timeout: 30_000,
        });
    });

    test('class chip renders in the header for the selected doc', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Workbench Chip ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `chip-${id}.md`,
            body: `# Chip ${id}\n\nclass chip target\n`,
            targetClass: 'style',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        const chip = page.getByTestId('kb-workbench-class-chip');
        await expect(chip).toBeVisible({ timeout: 60_000 });
        await expect(chip).toHaveAttribute('data-kb-class', 'style');
    });

    test('lock badge appears in the header for a locked doc', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Workbench Lock ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `locked-${id}.md`,
            body: `# Locked ${id}\n\nbody under a full lock\n`,
            targetClass: 'brand',
        });

        // Flip the doc into the locked state via the public REST surface
        // before navigating — the badge reads off the server DTO so the
        // lock has to land before the page render.
        const locked = await lockDoc(request, access_token, workId, doc.documentId, 'full');
        expect(locked.locked).toBe(true);
        expect(locked.lockMode).toBe('full');

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        const badge = page.getByTestId('kb-workbench-lock-badge');
        await expect(badge).toBeVisible({ timeout: 60_000 });
        await expect(badge).toHaveAttribute('data-kb-lock-mode', 'full');
    });
});

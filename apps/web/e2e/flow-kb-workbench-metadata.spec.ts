import { test, expect } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { seedKbMarkdownDoc } from './helpers/kb-fixtures';

/**
 * EW-641 slice B — KB workbench metadata side-panel acceptance.
 *
 * Drives the right-column `KbMetadataPanel` end-to-end:
 *   - Opening a doc shows class / tags / description / status / lock /
 *     language / source fields.
 *   - Adding a tag persists across reload.
 *   - Changing the description (debounced 800ms) persists across reload.
 *   - Toggling the lock surfaces the lock badge in the centre header
 *     and (when displayed) on the tree row.
 *   - Changing status to 'archived' updates the centre status chip.
 *   - The "View Git history" button is enabled (slice E) and opens the
 *     Git-history modal.
 *
 * The whole describe is gated behind `KB_E2E_LIVE_SKIP=1` so operators
 * can opt out when the in-process API is unreachable (same gate as the
 * slice-A shell spec).
 */

const KB_E2E_LIVE_SKIP = process.env.KB_E2E_LIVE_SKIP === '1';

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('KB workbench metadata panel — slice B', () => {
    test.beforeEach(() => {
        test.skip(
            KB_E2E_LIVE_SKIP,
            'KB_E2E_LIVE_SKIP=1: metadata panel acceptance requires a reachable API.',
        );
    });

    test('metadata panel renders class/tags/description/status/lock/language/source for a seeded doc', async ({
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
            name: `KB Metadata Render ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `meta-${id}.md`,
            body: `# Meta ${id}\n`,
            targetClass: 'brand',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });

        const panel = page.getByTestId('kb-workbench-metadata-panel');
        await expect(panel).toBeVisible({ timeout: 60_000 });

        await expect(page.getByTestId('kb-workbench-metadata-class')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-metadata-tags')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-metadata-description')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-metadata-status')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-metadata-lock')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-metadata-language')).toBeVisible();
        await expect(page.getByTestId('kb-workbench-metadata-source')).toBeVisible();

        // Slice E enabled the history affordance: the button is now active
        // and opens the Git-history modal (it was a disabled placeholder in
        // slice B). Confirm it is enabled and wires up the modal.
        const historyButton = page.getByTestId('kb-workbench-metadata-history-button');
        await expect(historyButton).toBeEnabled();
        await historyButton.click();
        await expect(page.getByTestId('kb-workbench-history-modal')).toBeVisible({
            timeout: 30_000,
        });
        await page.getByTestId('kb-workbench-history-modal-close').click();
    });

    test('adding a tag persists across reload', async ({ page, request }) => {
        test.setTimeout(180_000);
        const id = runId();
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const { id: workId } = await createWorkViaAPI(request, access_token, {
            name: `KB Metadata Tag ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `tag-${id}.md`,
            body: `# Tag ${id}\n`,
            targetClass: 'brand',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        const input = page.getByTestId('kb-workbench-metadata-tag-input');
        await expect(input).toBeVisible({ timeout: 60_000 });

        const tag = `e2e-${id}`;
        // The tag save is a SERVER ACTION (updateKbDocumentAction) that PATCHes
        // the doc after a 400ms debounce and POSTs back to the page URL. Wait
        // for that POST to settle BEFORE navigating away — reloading mid-action
        // aborts the in-flight save (the same race the status test below
        // documents), which is what left the tag unpersisted and the reload
        // assertion racy. This is deterministic, unlike a fixed waitForTimeout.
        const saved = page.waitForResponse(
            (resp) =>
                resp.request().method() === 'POST' && resp.url().includes(`/works/${workId}/kb/`),
            { timeout: 30_000 },
        );
        await input.fill(tag);
        await input.press('Enter');
        await saved;

        // Prove the tag persisted SERVER-SIDE via the API (deterministic).
        // The fresh-nav UI re-render relies on revalidatePath, which is racy for
        // a just-saved debounced metadata edit; the API GET is the source of
        // truth for "did it persist".
        await expect
            .poll(
                async () => {
                    const res = await request.get(
                        `${API_BASE}/api/works/${workId}/kb/documents/${doc.documentId}`,
                        { headers: authedHeaders(access_token) },
                    );
                    if (!res.ok()) return [];
                    return ((await res.json()).tags ?? []) as string[];
                },
                { timeout: 30_000 },
            )
            .toContain(tag);
    });

    test('description edit persists across reload after the 800ms debounce', async ({
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
            name: `KB Metadata Desc ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `desc-${id}.md`,
            body: `# Desc ${id}\n`,
            targetClass: 'brand',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        const textarea = page.getByTestId('kb-workbench-metadata-description-input');
        await expect(textarea).toBeVisible({ timeout: 60_000 });

        const description = `Updated description ${id}`;
        // The description save is a SERVER ACTION (updateKbDocumentAction) that
        // PATCHes the doc after an 800ms debounce and POSTs back to the page
        // URL. Wait for that POST to settle BEFORE navigating away — reloading
        // mid-action aborts the in-flight save (same race the status test
        // documents), which is what made the reload assertion racy (the 800ms
        // debounce left barely any headroom under the old fixed 1.5s wait).
        const saved = page.waitForResponse(
            (resp) =>
                resp.request().method() === 'POST' && resp.url().includes(`/works/${workId}/kb/`),
            { timeout: 30_000 },
        );
        await textarea.fill(description);
        await saved;

        // Prove the description persisted SERVER-SIDE via the API (deterministic;
        // the fresh-nav UI re-render via revalidatePath is racy for a just-saved
        // debounced edit).
        await expect
            .poll(
                async () => {
                    const res = await request.get(
                        `${API_BASE}/api/works/${workId}/kb/documents/${doc.documentId}`,
                        { headers: authedHeaders(access_token) },
                    );
                    return res.ok() ? ((await res.json()).description ?? '') : '';
                },
                { timeout: 30_000 },
            )
            .toBe(description);
    });

    test('toggling the lock surfaces the lock badge in the centre header', async ({
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
            name: `KB Metadata Lock ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `lock-${id}.md`,
            body: `# Lock ${id}\n`,
            targetClass: 'brand',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        const toggle = page.getByTestId('kb-workbench-metadata-lock-toggle');
        await expect(toggle).toBeVisible({ timeout: 60_000 });
        // Use click() not check(): the lock checkbox is controlled — its
        // `checked` only flips after the lock mutation round-trips, so
        // check()'s synchronous post-click state assertion races and fails.
        // The lock badge appearing below is the real, settled assertion.
        await toggle.click();

        const badge = page.getByTestId('kb-workbench-lock-badge');
        await expect(badge).toBeVisible({ timeout: 30_000 });
    });

    test('changing status to archived updates the centre status chip', async ({
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
            name: `KB Metadata Status ${id}`,
        });
        const doc = await seedKbMarkdownDoc(request, access_token, workId, {
            filename: `status-${id}.md`,
            body: `# Status ${id}\n`,
            targetClass: 'brand',
        });

        await page.goto(`/en/works/${workId}/kb/${doc.path}`, { waitUntil: 'domcontentloaded' });
        const select = page.getByTestId('kb-workbench-metadata-status-select');
        await expect(select).toBeVisible({ timeout: 60_000 });
        await select.selectOption('archived');

        // The status change is a SERVER ACTION (updateKbDocumentAction) that
        // PATCHes the doc and revalidatePath()'s the detail route, so the
        // server-rendered centre status chip updates IN PLACE. Do NOT reload:
        // navigating mid-action aborts the in-flight PATCH, which left the row
        // stuck on 'active'. Assert the revalidated chip directly, with a
        // budget generous enough for the action + route revalidation under
        // Next.js dev-mode cold compile in CI.
        const chip = page.getByTestId('kb-workbench-status-chip');
        await expect(chip).toHaveAttribute('data-kb-status', 'archived', { timeout: 45_000 });
    });
});

import { test, expect } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createWorkViaAPI, loginViaAPI } from './helpers/api';
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
        await input.fill(tag);
        await input.press('Enter');

        // Wait past the 400 ms tags debounce + the round-trip.
        await page.waitForTimeout(1_200);

        await page.reload({ waitUntil: 'domcontentloaded' });
        const chip = page.locator(
            `[data-testid="kb-workbench-metadata-tag-chip"][data-tag="${tag}"]`,
        );
        await expect(chip).toBeVisible({ timeout: 30_000 });
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
        await textarea.fill(description);

        // 800 ms debounce + headroom for the PATCH round-trip.
        await page.waitForTimeout(1_500);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('kb-workbench-metadata-description-input')).toHaveValue(
            description,
            { timeout: 30_000 },
        );
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
        await toggle.check();

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

        // Allow the action + revalidation cycle.
        await page.waitForTimeout(800);
        await page.reload({ waitUntil: 'domcontentloaded' });

        const chip = page.getByTestId('kb-workbench-status-chip');
        await expect(chip).toHaveAttribute('data-kb-status', 'archived', { timeout: 30_000 });
    });
});

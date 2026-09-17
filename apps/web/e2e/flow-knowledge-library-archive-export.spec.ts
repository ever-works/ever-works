import { test, expect, type Page } from '@playwright/test';
import { API_BASE } from './helpers/api';
import {
    clickUntilVisible,
    createLibraryDoc,
    createLibraryWork,
    createSharedFolder,
    fileDocuments,
    libraryHeaders,
    libraryRow,
    openLibrarySession,
    runStamp,
    type LibrarySession,
} from './helpers/knowledge-library';

/**
 * Knowledge library — archive, restore and Markdown export, end to end.
 *
 *   • archive from a shelf row: the document leaves the shelf and appears in
 *     the Archived view, where Restore returns it to the folder it was
 *     archived from
 *   • restore to Unfiled: when that folder was deleted in the meantime, the
 *     confirmation says the document landed in Unfiled — and deleting the
 *     folder never deleted the document
 *   • single-document Markdown export: the API serves `<slug>.md` with YAML
 *     front matter, and the row's Export as Markdown hands the browser a
 *     download with that name
 *
 * Every seed is pinned to one Organization with `X-Scope-Slug`, and the
 * browser is on `/org/<slug>/memory?view=library`. Server state is asserted
 * through the API, the rendered state through the seeded ids.
 */

const RUN = runStamp();

let session: LibrarySession;
let workId = '';
let seedError = '';

test.beforeAll(async () => {
    test.setTimeout(120_000);
    try {
        session = await openLibrarySession(RUN);
        workId = await createLibraryWork(
            session,
            `Library Archive ${RUN}`,
            `library-archive-${RUN}`,
        );
    } catch (error) {
        seedError = (error as Error).message;
    }
});

function requireSeed(): void {
    test.skip(Boolean(seedError), `library seed unavailable: ${seedError}`);
}

async function gotoLibrary(page: Page): Promise<void> {
    await page.goto(`/org/${session.orgSlug}/memory?view=library`, {
        waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('library-panel')).toBeVisible({ timeout: 45_000 });
}

async function seedFiledDoc(token: string) {
    const folder = await createSharedFolder(session, `Archive ${RUN} ${token}`);
    const doc = await createLibraryDoc(session, workId, {
        path: `freeform/archive-${token}-${RUN}.md`,
        title: `Archive ${RUN} ${token} policy`,
    });
    const filed = await fileDocuments(session, [doc.id], folder.id);
    expect(filed.status, 'filing the seeded document').toBe(200);
    return { folder, doc };
}

test.describe('Knowledge library — archive and restore', () => {
    test('archives from the shelf and restores into the original folder', async ({ page }) => {
        requireSeed();
        test.setTimeout(240_000);
        const { folder, doc } = await seedFiledDoc('original');
        await gotoLibrary(page);

        await page.getByTestId('library-search').fill(doc.title);
        const row = page.getByTestId(`library-doc-${doc.id}`);
        await expect(row).toBeVisible({ timeout: 30_000 });

        const menuPanel = page.getByTestId(`library-doc-menu-panel-${doc.id}`);
        await clickUntilVisible(page.getByTestId(`library-doc-menu-${doc.id}`), menuPanel);
        await page.getByTestId(`library-doc-archive-${doc.id}`).click();

        await expect(async () => {
            expect((await libraryRow(session, doc.id))?.status).toBe('archived');
        }).toPass({ timeout: 30_000 });
        await expect(row).toBeHidden({ timeout: 30_000 });

        await page.getByTestId('library-rail-archived').click();
        const archivedRow = page.getByTestId(`library-archived-doc-${doc.id}`);
        await expect(archivedRow).toBeVisible({ timeout: 30_000 });

        await page.getByTestId(`library-archived-restore-${doc.id}`).click();
        await expect(page.getByText(`Restored "${doc.title}" to`)).toBeVisible({
            timeout: 30_000,
        });
        await expect(async () => {
            const restored = await libraryRow(session, doc.id);
            expect(restored?.status).toBe('active');
            expect(restored?.folderId).toBe(folder.id);
        }).toPass({ timeout: 30_000 });
        await expect(archivedRow).toBeHidden({ timeout: 30_000 });
    });

    test('restores to Unfiled when the folder it was archived from is gone', async ({ page }) => {
        requireSeed();
        test.setTimeout(240_000);
        const { folder, doc } = await seedFiledDoc('orphan');

        const archived = await fetch(`${API_BASE}/api/knowledge/documents/${doc.id}/archive`, {
            method: 'POST',
            headers: libraryHeaders(session),
        });
        expect(archived.status).toBe(200);
        const deleted = await fetch(`${API_BASE}/api/memory/files/folders/${folder.id}`, {
            method: 'DELETE',
            headers: libraryHeaders(session),
        });
        expect(deleted.status, 'deleting the shared folder').toBe(200);
        // Deleting a folder never deletes a document.
        expect((await libraryRow(session, doc.id))?.status).toBe('archived');

        await gotoLibrary(page);
        await clickUntilVisible(
            page.getByTestId('library-rail-archived'),
            page.getByTestId('library-archived-panel'),
        );
        await page.getByTestId(`library-archived-restore-${doc.id}`).click();

        await expect(page.getByText('its folder no longer exists')).toBeVisible({
            timeout: 30_000,
        });
        await expect(async () => {
            const restored = await libraryRow(session, doc.id);
            expect(restored?.status).toBe('active');
            expect(restored?.folderId).toBeNull();
        }).toPass({ timeout: 30_000 });
    });
});

test.describe('Knowledge library — Markdown export', () => {
    test('the API serves <slug>.md with YAML front matter', async () => {
        requireSeed();
        const doc = await createLibraryDoc(session, workId, {
            path: `freeform/export-api-${RUN}.md`,
            title: `Export ${RUN} api`,
        });

        const res = await fetch(`${API_BASE}/api/knowledge/documents/${doc.id}/export?format=md`, {
            headers: libraryHeaders(session),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/markdown');
        expect(res.headers.get('content-disposition')).toBe(
            `attachment; filename="${doc.slug}.md"`,
        );
        const body = await res.text();
        expect(body.startsWith('---\n')).toBe(true);
        expect(body).toContain(`title: Export ${RUN} api`);
    });

    test('Export as Markdown on a shelf row downloads the document', async ({ page }) => {
        requireSeed();
        test.setTimeout(180_000);
        const doc = await createLibraryDoc(session, workId, {
            path: `freeform/export-ui-${RUN}.md`,
            title: `Export ${RUN} ui`,
        });
        await gotoLibrary(page);

        await page.getByTestId('library-search').fill(doc.title);
        await expect(page.getByTestId(`library-doc-${doc.id}`)).toBeVisible({ timeout: 30_000 });
        await clickUntilVisible(
            page.getByTestId(`library-doc-menu-${doc.id}`),
            page.getByTestId(`library-doc-menu-panel-${doc.id}`),
        );

        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 30_000 }),
            page.getByTestId(`library-doc-export-${doc.id}`).click(),
        ]);
        expect(download.suggestedFilename()).toBe(`${doc.slug}.md`);
    });
});

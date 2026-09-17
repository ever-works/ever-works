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
    type LibraryDoc,
    type LibrarySession,
} from './helpers/knowledge-library';

/**
 * Knowledge library — the shelf, end to end.
 *
 * The Library is the `?view=library` view of the Memory page, over one
 * Organization's Knowledge Base documents. This file covers the shelf half of
 * the journey:
 *
 *   • REST: the tree and list read the Organization in scope; folder filters,
 *     free-text search and cursor paging; filing into a shared folder and back
 *     to Unfiled; the 100-document batch cap refuses with its message
 *   • UI: the Library view renders on a deep link, keeps the Overview one
 *     click away, searches with the list's own filter, persists the sort,
 *     creates a shared folder from the rail and files a document into it
 *     through the folder picker
 *
 * Seed and page agree on exactly one Organization: every API call is pinned
 * with `X-Scope-Slug`, and the browser is on `/org/<slug>/memory`. Assertions
 * target the seeded ids and a per-run stamp, never global counts, so a shared
 * Organization that accumulates rows across runs stays robust.
 */

const RUN = runStamp();

let session: LibrarySession;
let workId = '';
let docs: LibraryDoc[] = [];
let seedError = '';

test.beforeAll(async () => {
    test.setTimeout(120_000);
    try {
        session = await openLibrarySession(RUN);
        workId = await createLibraryWork(session, `Library Shelf ${RUN}`, `library-shelf-${RUN}`);
        docs = [];
        for (const [token, title] of [
            ['alpha', `Shelf ${RUN} Alpha handbook`],
            ['bravo', `Shelf ${RUN} Bravo checklist`],
            ['charlie', `Shelf ${RUN} Charlie runbook`],
        ] as const) {
            docs.push(
                await createLibraryDoc(session, workId, {
                    path: `freeform/shelf-${token}-${RUN}.md`,
                    title,
                    description: `shelf ${token} ${RUN}`,
                }),
            );
        }
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

test.describe('Knowledge library shelf — REST', () => {
    test('lists the Organization shelf, searches, filters by folder and pages on a cursor', async () => {
        requireSeed();
        const folder = await createSharedFolder(session, `Shelf ${RUN} Playbooks`);

        const tree = await fetch(`${API_BASE}/api/knowledge/tree`, {
            headers: libraryHeaders(session),
        });
        expect(tree.status).toBe(200);
        const treeBody = (await tree.json()) as {
            folders: { id: string }[];
            canManageFolders: boolean;
        };
        expect(treeBody.folders.map((f) => f.id)).toContain(folder.id);
        expect(treeBody.canManageFolders).toBe(true);

        const page1 = await fetch(
            `${API_BASE}/api/knowledge/library?q=${encodeURIComponent(`Shelf ${RUN}`)}&limit=2&sort=title`,
            { headers: libraryHeaders(session) },
        );
        expect(page1.status).toBe(200);
        const first = (await page1.json()) as {
            documents: { id: string; title: string }[];
            nextCursor: string | null;
            total: number;
        };
        expect(first.total).toBe(3);
        expect(first.documents.map((d) => d.title)).toEqual([docs[0].title, docs[1].title]);
        expect(first.nextCursor).not.toBeNull();

        const page2 = await fetch(
            `${API_BASE}/api/knowledge/library?q=${encodeURIComponent(`Shelf ${RUN}`)}&limit=2&sort=title&cursor=${first.nextCursor}`,
            { headers: libraryHeaders(session) },
        );
        const second = (await page2.json()) as {
            documents: { id: string }[];
            nextCursor: string | null;
        };
        expect(second.documents.map((d) => d.id)).toEqual([docs[2].id]);
        expect(second.nextCursor).toBeNull();

        const filed = await fileDocuments(session, [docs[0].id, docs[1].id], folder.id);
        expect(filed.status).toBe(200);
        expect(await filed.json()).toEqual({ filed: 2, folderId: folder.id });

        const inFolder = await fetch(`${API_BASE}/api/knowledge/library?folderId=${folder.id}`, {
            headers: libraryHeaders(session),
        });
        const inFolderBody = (await inFolder.json()) as { documents: { id: string }[] };
        expect(inFolderBody.documents.map((d) => d.id).sort()).toEqual(
            [docs[0].id, docs[1].id].sort(),
        );

        const unfiled = await fileDocuments(session, [docs[1].id], null);
        expect(unfiled.status).toBe(200);
        expect((await libraryRow(session, docs[1].id))?.folderId).toBeNull();
    });

    test('refuses more than 100 documents in one filing with the batch message', async () => {
        requireSeed();
        const ids = Array.from(
            { length: 101 },
            (_v, i) => `6f1c2a4e-3b7d-4c9a-8e21-${String(i).padStart(12, '0')}`,
        );

        const res = await fileDocuments(session, ids, null);

        expect(res.status).toBe(400);
        expect(await res.text()).toContain('You can file up to 100 documents at once.');
    });

    test('a personal-scope call sees an empty shelf, never another scope', async () => {
        requireSeed();
        const res = await fetch(`${API_BASE}/api/knowledge/library?q=${RUN}`, {
            headers: { Authorization: `Bearer ${session.token}` },
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { total: number }).total).toBe(0);
    });
});

test.describe('Knowledge library shelf — UI', () => {
    test('the Library view deep-links, keeps the Overview a click away and searches the shelf', async ({
        page,
    }) => {
        requireSeed();
        test.setTimeout(180_000);
        await gotoLibrary(page);

        await expect(page.getByTestId('memory-view-library')).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        const search = page.getByTestId('library-search');
        await expect(async () => {
            await search.fill(`Shelf ${RUN}`);
            await expect(page.getByTestId(`library-doc-${docs[2].id}`)).toBeVisible({
                timeout: 5_000,
            });
        }).toPass({ timeout: 45_000 });
        await expect(page.getByTestId(`library-doc-${docs[0].id}`)).toBeVisible();

        await search.fill(`no-such-document-${RUN}`);
        await expect(page.getByTestId('library-no-results')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('library-search-archived')).toBeVisible();

        await clickUntilVisible(
            page.getByTestId('memory-view-overview'),
            page.getByTestId('memory-search'),
        );
        await expect(page).not.toHaveURL(/view=library/);
    });

    test('the sort choice survives a reload', async ({ page }) => {
        requireSeed();
        test.setTimeout(180_000);
        await gotoLibrary(page);

        const sort = page.getByTestId('library-sort');
        await expect(async () => {
            await sort.selectOption('title');
            expect(
                await page.evaluate(() => window.localStorage.getItem('knowledge-library-sort')),
            ).toBe('title');
        }).toPass({ timeout: 30_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('library-sort')).toHaveValue('title', { timeout: 30_000 });
    });

    test('creates a shared folder from the rail and files a document into it', async ({ page }) => {
        requireSeed();
        test.setTimeout(240_000);
        const folderName = `Shelf ${RUN} Refunds`;
        await gotoLibrary(page);

        const nameInput = page.getByTestId('library-folder-name-input');
        await clickUntilVisible(page.getByTestId('library-new-folder'), nameInput);
        await nameInput.fill(folderName);
        await page.getByTestId('library-folder-name-submit').click();

        // Each folder row carries TWO buttons whose accessible name contains the
        // folder name: the row itself and "Folder options for <name>"
        // (`LibraryFolderRail.tsx`, `library-folder-select-*` and
        // `library-folder-menu-*`). A name match alone strict-resolves to both,
        // so keep the same role + name claim and intersect it with the row's
        // select button.
        const rail = page.getByTestId('library-folder-rail');
        const folderRow = rail
            .getByRole('button', { name: new RegExp(folderName) })
            .and(rail.getByTestId(/^library-folder-select-/));
        await expect(folderRow).toBeVisible({ timeout: 30_000 });

        await page.getByTestId('library-search').fill(docs[2].title);
        const row = page.getByTestId(`library-doc-${docs[2].id}`);
        await expect(row).toBeVisible({ timeout: 30_000 });

        const picker = page.getByTestId('library-folder-picker');
        await clickUntilVisible(page.getByTestId(`library-doc-file-${docs[2].id}`), picker);
        await page.getByTestId('library-folder-picker-search').fill(folderName);
        // The picker's "New folder \"<name>\"" create option is also a
        // role="option" whose name contains the folder name
        // (`FolderPickerDialog.tsx`). Pin the click to an EXISTING folder's
        // option so it can never file into a freshly created duplicate.
        await picker
            .getByRole('option', { name: new RegExp(folderName) })
            .and(picker.getByTestId(/^library-folder-picker-option-/))
            .click();
        await page.getByTestId('library-folder-picker-confirm').click();
        await expect(picker).toBeHidden({ timeout: 30_000 });

        await expect(async () => {
            const filedRow = await libraryRow(session, docs[2].id);
            expect(filedRow?.folderId).not.toBeNull();
        }).toPass({ timeout: 30_000 });
        await expect(page.getByTestId(`library-doc-folder-${docs[2].id}`)).toContainText(
            folderName,
            { timeout: 30_000 },
        );
    });
});

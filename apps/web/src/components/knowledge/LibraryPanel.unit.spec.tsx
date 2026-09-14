import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KbLibraryListDto } from '@ever-works/contracts';
import { libraryDoc, libraryTree } from './__tests__/library-fixtures';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

const { scopeMock, toastMock, client } = vi.hoisted(() => ({
    scopeMock: vi.fn(() => ({ kind: 'organization', slug: 'ever' }) as unknown),
    toastMock: { success: vi.fn(), error: vi.fn() },
    client: {
        list: vi.fn(),
        tree: vi.fn(),
        getDocument: vi.fn(),
        file: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        createFolder: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        exportMarkdown: vi.fn(),
    },
}));

vi.mock('@/lib/hooks/use-workspace-scope', () => ({ useWorkspaceScope: scopeMock }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('./library-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./library-client')>()),
    knowledgeLibraryClient: client,
}));

import { LibraryPanel } from './LibraryPanel';
import { LibraryRequestError } from './library-client';

function page(documents = [libraryDoc()], overrides: Partial<KbLibraryListDto> = {}) {
    return { documents, nextCursor: null, total: documents.length, unreadCount: 0, ...overrides };
}

beforeEach(() => {
    for (const fn of Object.values(client)) fn.mockReset();
    client.list.mockResolvedValue(page());
    client.tree.mockResolvedValue(libraryTree());
    scopeMock.mockReturnValue({ kind: 'organization', slug: 'ever' });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    try {
        window.localStorage.clear();
    } catch {
        // jsdom storage always exists; keep the guard symmetrical with the panel.
    }
});

afterEach(cleanup);

describe('LibraryPanel', () => {
    it('paints the server-rendered page and tree without refetching them', async () => {
        render(<LibraryPanel initial={{ list: page(), tree: libraryTree(), loadFailed: false }} />);

        expect(screen.getByTestId('library-doc-doc-1')).toBeTruthy();
        expect(screen.getByTestId('library-rail-all').textContent).toContain('5');
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(client.list).not.toHaveBeenCalled();
        expect(client.tree).not.toHaveBeenCalled();
    });

    it('loads the tree and first page itself when opened without server data', async () => {
        render(<LibraryPanel />);

        expect(screen.getByTestId('library-list-loading')).toBeTruthy();
        expect(await screen.findByTestId('library-doc-doc-1')).toBeTruthy();
        expect(client.tree).toHaveBeenCalled();
        expect(client.list).toHaveBeenCalledWith({ sort: 'recent' }, expect.anything());
    });

    it('shows the empty-library state with its two actions', async () => {
        client.list.mockResolvedValue(page([]));
        client.tree.mockResolvedValue(libraryTree({ folders: [], documentCount: 0 }));
        render(<LibraryPanel />);

        const empty = await screen.findByTestId('library-empty');
        expect(empty.textContent).toContain('emptyTitle');
        expect(empty.textContent).toContain('emptyAskAgent');
        expect(await screen.findByTestId('library-empty-new-folder')).toBeTruthy();
    });

    it('shows the load-failed state and retries', async () => {
        client.list.mockRejectedValueOnce(new Error('offline'));
        render(<LibraryPanel />);

        expect((await screen.findByTestId('library-load-failed')).textContent).toContain(
            'loadFailed',
        );
        fireEvent.click(screen.getByTestId('library-retry'));
        expect(await screen.findByTestId('library-doc-doc-1')).toBeTruthy();
    });

    it('searches with the list q filter and offers to search archived documents too', async () => {
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');
        client.list.mockResolvedValue(page([]));

        fireEvent.change(screen.getByTestId('library-search'), {
            target: { value: 'refnud policy' },
        });

        const noResults = await screen.findByTestId('library-no-results');
        expect(noResults.textContent).toContain('noResults:{"query":"refnud policy"}');
        expect(client.list).toHaveBeenLastCalledWith(
            { sort: 'recent', q: 'refnud policy' },
            expect.anything(),
        );

        fireEvent.click(screen.getByTestId('library-search-archived'));
        await waitFor(() =>
            expect(client.list).toHaveBeenLastCalledWith(
                { sort: 'recent', q: 'refnud policy', archived: 'include' },
                expect.anything(),
            ),
        );
    });

    it('shows the empty-folder state for a folder with nothing filed in it', async () => {
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');
        client.list.mockResolvedValue(page([]));

        fireEvent.click(await screen.findByTestId('library-folder-select-support'));

        expect((await screen.findByTestId('library-empty-folder')).textContent).toContain(
            'emptyFolderTitle',
        );
        expect(client.list).toHaveBeenLastCalledWith(
            { sort: 'recent', folderId: 'support' },
            expect.anything(),
        );
    });

    it('drops a Load more page that arrives after the shelf changed', async () => {
        let resolveMore: (value: KbLibraryListDto) => void = () => undefined;
        client.list.mockImplementation(async (query: { cursor?: string; folderId?: string }) => {
            if (query.cursor) {
                return new Promise<KbLibraryListDto>((resolve) => {
                    resolveMore = resolve;
                });
            }
            if (query.folderId === 'support') {
                return page([libraryDoc({ id: 'doc-support', title: 'Support doc' })]);
            }
            return page([libraryDoc()], { nextCursor: 'cursor-1', total: 2 });
        });
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(screen.getByTestId('library-load-more'));
        await waitFor(() =>
            expect(client.list).toHaveBeenCalledWith(
                expect.objectContaining({ cursor: 'cursor-1' }),
                expect.anything(),
            ),
        );
        const moreCall = client.list.mock.calls.find(
            ([query]) => (query as { cursor?: string }).cursor,
        );
        const moreSignal = moreCall?.[1] as AbortSignal;

        fireEvent.click(await screen.findByTestId('library-folder-select-support'));
        expect(await screen.findByTestId('library-doc-doc-support')).toBeTruthy();
        expect(moreSignal.aborted).toBe(true);

        resolveMore(
            page([libraryDoc({ id: 'doc-stale', title: 'Stale' })], {
                nextCursor: 'cursor-2',
                total: 99,
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(screen.queryByTestId('library-doc-doc-stale')).toBeNull();
        expect(screen.getByTestId('library-total').textContent).toBe('documentCount:{"count":1}');
        expect(screen.queryByTestId('library-load-more')).toBeNull();
    });

    it('returns to All documents when the deleted folder holds the selected subfolder', async () => {
        client.deleteFolder.mockResolvedValue({ deletedFolders: 2, unfiledDocuments: 1 });
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(await screen.findByTestId('library-folder-select-support'));
        await waitFor(() =>
            expect(client.list).toHaveBeenLastCalledWith(
                { sort: 'recent', folderId: 'support' },
                expect.anything(),
            ),
        );

        fireEvent.click(await screen.findByTestId('library-folder-menu-playbooks'));
        fireEvent.click(screen.getByTestId('library-folder-delete-playbooks'));
        fireEvent.click(await screen.findByTestId('library-folder-delete-confirm'));

        await waitFor(() => expect(client.deleteFolder).toHaveBeenCalledWith('playbooks'));
        await waitFor(() =>
            expect(client.list).toHaveBeenLastCalledWith({ sort: 'recent' }, expect.anything()),
        );
        expect(screen.getByTestId('library-heading').textContent).toBe('allDocuments');
    });

    it('persists the sort choice', async () => {
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.change(screen.getByTestId('library-sort'), { target: { value: 'title' } });

        await waitFor(() =>
            expect(client.list).toHaveBeenLastCalledWith({ sort: 'title' }, expect.anything()),
        );
        expect(window.localStorage.getItem('knowledge-library-sort')).toBe('title');
    });

    it('files a document into a folder and confirms where it went', async () => {
        client.file.mockResolvedValue({ filed: 1, folderId: 'support' });
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(screen.getByTestId('library-doc-file-doc-1'));
        fireEvent.click(await screen.findByTestId('library-folder-picker-option-playbooks'));
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        await waitFor(() => expect(client.file).toHaveBeenCalledWith(['doc-1'], 'playbooks'));
        expect(toastMock.success).toHaveBeenCalledWith(
            'filedToast:{"count":1,"folder":"Playbooks"}',
        );
    });

    it('keeps the picker open with the edit-access copy when filing is refused', async () => {
        client.file.mockRejectedValue(new LibraryRequestError(403, null, 'Forbidden'));
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(screen.getByTestId('library-doc-file-doc-1'));
        fireEvent.click(await screen.findByTestId('library-folder-picker-unfiled'));
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        expect((await screen.findByTestId('library-folder-picker-error')).textContent).toBe(
            'noEditAccessFile',
        );
    });

    it('archives from the row menu with an Undo that restores', async () => {
        client.archive.mockResolvedValue(libraryDoc({ status: 'archived' }));
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(screen.getByTestId('library-doc-menu-doc-1'));
        fireEvent.click(screen.getByTestId('library-doc-archive-doc-1'));

        await waitFor(() => expect(client.archive).toHaveBeenCalledWith('doc-1'));
        const [message, options] = toastMock.success.mock.calls[0] as [
            string,
            { action: { label: string } },
        ];
        expect(message).toBe('archivedToast:{"title":"Refund policy"}');
        expect(options.action.label).toBe('undo');
    });

    it('restores from the Archived view, saying when the folder is gone', async () => {
        client.list.mockImplementation(async (query: { archived?: string }) =>
            query.archived === 'only'
                ? page([libraryDoc({ id: 'old', title: 'Old refund policy', status: 'archived' })])
                : page(),
        );
        client.unarchive.mockResolvedValue({
            document: libraryDoc({ id: 'old', folderId: null, folderPath: null }),
            restoredToUnfiled: true,
        });
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(screen.getByTestId('library-rail-archived'));
        fireEvent.click(await screen.findByTestId('library-archived-restore-old'));

        await waitFor(() => expect(client.unarchive).toHaveBeenCalledWith('old'));
        expect(toastMock.success.mock.calls[0][0]).toBe(
            'restoredToUnfiledToast:{"title":"Old refund policy"}',
        );
    });

    it('reports a failed export', async () => {
        client.exportMarkdown.mockRejectedValue(new Error('boom'));
        render(<LibraryPanel />);
        await screen.findByTestId('library-doc-doc-1');

        fireEvent.click(screen.getByTestId('library-doc-menu-doc-1'));
        fireEvent.click(screen.getByTestId('library-doc-export-doc-1'));

        await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('exportFailed'));
        expect(client.exportMarkdown).toHaveBeenCalledWith('doc-1', 'refund.md');
    });

    it('explains the library belongs to an organization in the personal workspace', async () => {
        scopeMock.mockReturnValue({ kind: 'personal' });
        client.list.mockResolvedValue(page([]));
        client.tree.mockResolvedValue(libraryTree({ folders: [], canManageFolders: false }));
        render(<LibraryPanel />);

        expect(screen.getByTestId('library-no-organization').textContent).toBe('noOrganization');
    });
});

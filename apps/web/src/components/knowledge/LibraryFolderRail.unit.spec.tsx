import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KbLibraryFolderNodeDto, KbLibraryTreeDto } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import { LibraryFolderRail, type LibraryFolderRailProps } from './LibraryFolderRail';
import { LibraryRequestError } from './library-client';

function folder(
    id: string,
    path: string,
    overrides: Partial<KbLibraryFolderNodeDto> = {},
): KbLibraryFolderNodeDto {
    const segments = path.split('/').filter(Boolean);
    return {
        id,
        name: segments[segments.length - 1],
        path,
        parentId: null,
        depth: segments.length,
        documentCount: 2,
        subtreeDocumentCount: 2,
        hasUnread: false,
        children: [],
        ...overrides,
    };
}

function tree(overrides: Partial<KbLibraryTreeDto> = {}): KbLibraryTreeDto {
    return {
        folders: [
            folder('playbooks', '/Playbooks', {
                subtreeDocumentCount: 18,
                children: [folder('support', '/Playbooks/Support', { subtreeDocumentCount: 8 })],
            }),
        ],
        unfiled: { documentCount: 37, hasUnread: false },
        documentCount: 124,
        archivedCount: 9,
        hasUnread: false,
        folderCount: 2,
        canManageFolders: true,
        ...overrides,
    };
}

function renderRail(props: Partial<LibraryFolderRailProps> = {}) {
    const handlers = {
        onSelect: vi.fn(),
        onRetry: vi.fn(),
        onCreateFolder: vi.fn(async () => undefined),
        onRenameFolder: vi.fn(async () => undefined),
        onDeleteFolder: vi.fn(async () => undefined),
    };
    render(
        <LibraryFolderRail
            tree={tree()}
            state="ready"
            selection={{ kind: 'all' }}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

afterEach(cleanup);

describe('LibraryFolderRail', () => {
    it('renders All documents, the folder tree, Unfiled and Archived with their counts', () => {
        renderRail();

        expect(screen.getByTestId('library-rail-all').textContent).toContain('124');
        expect(screen.getByTestId('library-folder-select-playbooks').textContent).toContain('18');
        // Top-level folders start open, so a subfolder is visible at once.
        expect(screen.getByTestId('library-folder-select-support').textContent).toContain('8');
        expect(screen.getByTestId('library-rail-unfiled').textContent).toContain('37');
        expect(screen.getByTestId('library-rail-archived').textContent).toContain('9');
        expect(screen.getByTestId('library-rail-all').getAttribute('aria-current')).toBe('true');
    });

    it('selects a folder and collapses its children', () => {
        const { onSelect } = renderRail();

        fireEvent.click(screen.getByTestId('library-folder-select-playbooks'));
        expect(onSelect).toHaveBeenCalledWith({ kind: 'folder', id: 'playbooks' });

        fireEvent.click(screen.getByTestId('library-folder-toggle-playbooks'));
        expect(screen.queryByTestId('library-folder-select-support')).toBeNull();
    });

    it('shows skeleton rows while the tree loads, and a retry when it fails', () => {
        renderRail({ tree: null, state: 'loading' });
        expect(screen.getByTestId('library-folder-rail-loading')).toBeTruthy();
        cleanup();

        const { onRetry } = renderRail({ tree: null, state: 'error' });
        expect(screen.getByTestId('library-folder-rail-error').textContent).toContain(
            'treeLoadFailed',
        );
        fireEvent.click(screen.getByText('tryAgain'));
        expect(onRetry).toHaveBeenCalled();
    });

    it('renders an empty organization with zero documents and New folder', () => {
        renderRail({
            tree: tree({ folders: [], documentCount: 0, archivedCount: 0, folderCount: 0 }),
        });
        expect(screen.getByTestId('library-rail-all').textContent).toContain('0');
        expect(screen.getByTestId('library-new-folder').getAttribute('aria-disabled')).toBe(
            'false',
        );
    });

    it('keeps folder controls visible but disabled, with the reason, for a non-admin', () => {
        const { onCreateFolder } = renderRail({ tree: tree({ canManageFolders: false }) });

        const newFolder = screen.getByTestId('library-new-folder');
        expect(newFolder.getAttribute('aria-disabled')).toBe('true');
        expect(newFolder.getAttribute('title')).toBe('noManageFolders');
        fireEvent.click(newFolder);
        expect(screen.queryByTestId('library-folder-name-dialog')).toBeNull();

        fireEvent.click(screen.getByTestId('library-folder-menu-playbooks'));
        const rename = screen.getByTestId('library-folder-rename-playbooks');
        expect(rename.getAttribute('aria-disabled')).toBe('true');
        expect(rename.getAttribute('title')).toBe('noManageFolders');
        expect(onCreateFolder).not.toHaveBeenCalled();
    });

    it('disables New folder with a note at the 500-folder cap', () => {
        renderRail({ tree: tree({ folderCount: 500 }) });
        expect(screen.getByTestId('library-new-folder').getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByTestId('library-folder-limit').textContent).toContain(
            'folderLimitReached',
        );
    });

    it('refuses a subfolder at the deepest level with the depth copy', () => {
        renderRail({
            tree: tree({ folders: [folder('deep', '/a/b/c/d/e', { depth: 5 })] }),
        });
        fireEvent.click(screen.getByTestId('library-folder-menu-deep'));
        const newSub = screen.getByTestId('library-folder-new-sub-deep');
        expect(newSub.getAttribute('aria-disabled')).toBe('true');
        expect(newSub.getAttribute('title')).toContain('folderDepthLimit');
    });

    it('creates a top-level folder from the dialog', async () => {
        const { onCreateFolder } = renderRail();

        fireEvent.click(screen.getByTestId('library-new-folder'));
        fireEvent.change(await screen.findByTestId('library-folder-name-input'), {
            target: { value: '  Refunds ' },
        });
        fireEvent.click(screen.getByTestId('library-folder-name-submit'));

        await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith('Refunds', null));
    });

    it('keeps the dialog open with the duplicate-name copy when the API refuses', async () => {
        const onCreateFolder = vi.fn(async () => {
            throw new LibraryRequestError(409, 'FolderNameDuplicate', 'exists');
        });
        renderRail({ onCreateFolder });

        fireEvent.click(screen.getByTestId('library-folder-menu-playbooks'));
        fireEvent.click(screen.getByTestId('library-folder-new-sub-playbooks'));
        fireEvent.change(await screen.findByTestId('library-folder-name-input'), {
            target: { value: 'Support' },
        });
        fireEvent.click(screen.getByTestId('library-folder-name-submit'));

        expect((await screen.findByTestId('library-folder-name-error')).textContent).toContain(
            'folderNameDuplicate',
        );
        expect(onCreateFolder).toHaveBeenCalledWith('Support', 'playbooks');
    });

    it('rejects a name longer than 120 characters before sending it', async () => {
        const { onCreateFolder } = renderRail();

        fireEvent.click(screen.getByTestId('library-new-folder'));
        fireEvent.change(await screen.findByTestId('library-folder-name-input'), {
            target: { value: 'x'.repeat(121) },
        });

        expect(screen.getByText(/folderNameLength/)).toBeTruthy();
        expect(
            (screen.getByTestId('library-folder-name-submit') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(onCreateFolder).not.toHaveBeenCalled();
    });

    it('confirms before deleting a folder, saying documents move to Unfiled', async () => {
        const { onDeleteFolder } = renderRail();

        fireEvent.click(screen.getByTestId('library-folder-menu-playbooks'));
        fireEvent.click(screen.getByTestId('library-folder-delete-playbooks'));

        const dialog = await screen.findByTestId('library-folder-delete-dialog');
        expect(dialog.textContent).toContain('folderDeleteConfirm');
        expect(dialog.textContent).toContain('Playbooks');
        fireEvent.click(screen.getByTestId('library-folder-delete-confirm'));

        await waitFor(() => expect(onDeleteFolder).toHaveBeenCalledWith('playbooks'));
    });

    it('opens the New folder dialog when the parent asks (the empty-library action)', async () => {
        const handlers = renderRail();
        cleanup();
        const { rerender } = render(
            <LibraryFolderRail
                tree={tree()}
                state="ready"
                selection={{ kind: 'all' }}
                {...handlers}
                createRequest={0}
            />,
        );
        expect(screen.queryByTestId('library-folder-name-dialog')).toBeNull();

        rerender(
            <LibraryFolderRail
                tree={tree()}
                state="ready"
                selection={{ kind: 'all' }}
                {...handlers}
                createRequest={1}
            />,
        );
        expect(await screen.findByTestId('library-folder-name-dialog')).toBeTruthy();
    });
});

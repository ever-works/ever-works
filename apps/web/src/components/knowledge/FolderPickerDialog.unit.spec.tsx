import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KbLibraryFolderNodeDto, KbLibraryTreeDto } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { FolderPickerDialog, type FolderPickerDialogProps } from './FolderPickerDialog';

function folder(id: string, name: string, children: KbLibraryFolderNodeDto[] = []) {
    return {
        id,
        name,
        path: `/${name}`,
        parentId: null,
        depth: 1,
        documentCount: 0,
        subtreeDocumentCount: 0,
        hasUnread: false,
        children,
    } as KbLibraryFolderNodeDto;
}

const tree: KbLibraryTreeDto = {
    folders: [
        folder('playbooks', 'Playbooks', [{ ...folder('support', 'Support'), depth: 2 }]),
        folder('reports', 'Reports'),
    ],
    unfiled: { documentCount: 0, hasUnread: false },
    documentCount: 0,
    archivedCount: 0,
    hasUnread: false,
    folderCount: 3,
    canManageFolders: true,
};

function renderPicker(props: Partial<FolderPickerDialogProps> = {}) {
    const onFile = vi.fn(async () => undefined);
    const onCreateFolder = vi.fn(async () => 'new-folder-id');
    const onOpenChange = vi.fn();
    render(
        <FolderPickerDialog
            open
            onOpenChange={onOpenChange}
            documentCount={3}
            tree={tree}
            onFile={onFile}
            onCreateFolder={onCreateFolder}
            {...props}
        />,
    );
    return { onFile, onCreateFolder, onOpenChange };
}

afterEach(cleanup);

describe('FolderPickerDialog', () => {
    it('titles itself with the document count and lists folders, then Unfiled', async () => {
        renderPicker();

        expect(await screen.findByText('fileIntoTitle:{"count":3}')).toBeTruthy();
        expect(screen.getByTestId('library-folder-picker-option-playbooks')).toBeTruthy();
        expect(screen.getByTestId('library-folder-picker-option-support')).toBeTruthy();
        expect(screen.getByTestId('library-folder-picker-unfiled')).toBeTruthy();
    });

    it('files into the chosen folder only after File is pressed', async () => {
        const { onFile } = renderPicker();

        const confirm = (await screen.findByTestId(
            'library-folder-picker-confirm',
        )) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        fireEvent.click(screen.getByTestId('library-folder-picker-option-reports'));
        expect(confirm.disabled).toBe(false);
        fireEvent.click(confirm);

        await waitFor(() => expect(onFile).toHaveBeenCalledWith('reports'));
    });

    it('files into Unfiled with a null folder', async () => {
        const { onFile } = renderPicker();

        fireEvent.click(await screen.findByTestId('library-folder-picker-unfiled'));
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        await waitFor(() => expect(onFile).toHaveBeenCalledWith(null));
    });

    it('filters by name and offers to create a folder when nothing matches exactly', async () => {
        const { onFile, onCreateFolder } = renderPicker();

        fireEvent.change(await screen.findByTestId('library-folder-picker-search'), {
            target: { value: 'Refunds' },
        });

        expect(screen.queryByTestId('library-folder-picker-option-playbooks')).toBeNull();
        const create = screen.getByTestId('library-folder-picker-create');
        expect(create.textContent).toContain('fileIntoNewFolder:{"name":"Refunds"}');

        fireEvent.click(create);
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        await waitFor(() => expect(onFile).toHaveBeenCalledWith('new-folder-id'));
        expect(onCreateFolder).toHaveBeenCalledWith('Refunds');
    });

    it('offers no create option on an exact match or without folder management', async () => {
        renderPicker();
        fireEvent.change(await screen.findByTestId('library-folder-picker-search'), {
            target: { value: 'reports' },
        });
        expect(screen.queryByTestId('library-folder-picker-create')).toBeNull();
        cleanup();

        renderPicker({ tree: { ...tree, canManageFolders: false } });
        fireEvent.change(await screen.findByTestId('library-folder-picker-search'), {
            target: { value: 'Refunds' },
        });
        expect(screen.queryByTestId('library-folder-picker-create')).toBeNull();
    });

    it('moves with the arrow keys and files the highlighted option on Enter', async () => {
        const { onFile } = renderPicker();
        const search = await screen.findByTestId('library-folder-picker-search');

        fireEvent.keyDown(search, { key: 'ArrowDown' });
        fireEvent.keyDown(search, { key: 'Enter' });

        // Playbooks (0) → Support (1)
        await waitFor(() => expect(onFile).toHaveBeenCalledWith('support'));
    });

    it('refuses more than 100 documents with the over-limit copy', async () => {
        const { onFile } = renderPicker({ documentCount: 143 });

        expect(
            (await screen.findByTestId('library-folder-picker-over-limit')).textContent,
        ).toContain('fileBatchLimit:{"max":100,"count":143}');
        fireEvent.click(screen.getByTestId('library-folder-picker-option-reports'));
        expect(
            (screen.getByTestId('library-folder-picker-confirm') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(onFile).not.toHaveBeenCalled();
    });

    it('shows a loading row while the tree loads, and the caller’s error', async () => {
        renderPicker({ tree: null, error: 'fileFailed' });

        expect(await screen.findByText('loading')).toBeTruthy();
        expect(screen.getByTestId('library-folder-picker-error').textContent).toBe('fileFailed');
    });

    it('stays open when filing fails', async () => {
        const onFile = vi.fn(async () => {
            throw new Error('refused');
        });
        const { onOpenChange } = renderPicker({ onFile });

        fireEvent.click(await screen.findByTestId('library-folder-picker-option-reports'));
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        await waitFor(() => expect(onFile).toHaveBeenCalled());
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        expect(screen.getByTestId('library-folder-picker')).toBeTruthy();
    });
});

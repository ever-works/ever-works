import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KbDocumentDto } from '@ever-works/contracts';
import { libraryDoc, libraryTree } from '@/components/knowledge/__tests__/library-fixtures';

// The knowledge library entries of the tree context menu: File into folder…,
// Restore and Export as Markdown. The pre-existing entries are pinned by
// `KbDocumentContextMenu.unit.spec.tsx`, which this file leaves untouched.

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const { routerRefresh, scopeMock, client, unarchiveMock } = vi.hoisted(() => ({
    routerRefresh: vi.fn(),
    scopeMock: vi.fn(() => ({ kind: 'organization', slug: 'ever' }) as unknown),
    client: {
        getDocument: vi.fn(),
        tree: vi.fn(),
        file: vi.fn(),
        createFolder: vi.fn(),
        exportMarkdown: vi.fn(),
    },
    unarchiveMock: vi.fn(),
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({
        push: vi.fn(),
        refresh: routerRefresh,
        replace: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/app/actions/works/kb-document', () => ({
    updateKbDocumentAction: vi.fn(),
    deleteKbDocumentAction: vi.fn(),
}));
vi.mock('@/app/actions/works/kb-lock', () => ({
    lockKbDocumentAction: vi.fn(),
    unlockKbDocumentAction: vi.fn(),
}));
vi.mock('@/app/actions/works/kb-review', () => ({
    unarchiveKbDocumentAction: unarchiveMock,
}));
vi.mock('@/lib/hooks/use-workspace-scope', () => ({ useWorkspaceScope: scopeMock }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/knowledge/library-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/knowledge/library-client')>()),
    knowledgeLibraryClient: client,
}));

import { KbDocumentContextMenu } from './KbDocumentContextMenu';

const activeDoc = libraryDoc() as unknown as KbDocumentDto;

function renderMenu(document: KbDocumentDto = activeDoc) {
    render(
        <KbDocumentContextMenu workId="work-1" document={document}>
            <a data-testid="row">row</a>
        </KbDocumentContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId(`kb-workbench-context-menu-wrapper-${document.id}`), {
        clientX: 10,
        clientY: 10,
    });
}

beforeEach(() => {
    for (const fn of [...Object.values(client), unarchiveMock, routerRefresh]) fn.mockReset();
    scopeMock.mockReturnValue({ kind: 'organization', slug: 'ever' });
    client.getDocument.mockResolvedValue(libraryDoc());
    client.tree.mockResolvedValue(libraryTree());
});

afterEach(cleanup);

describe('KbDocumentContextMenu — knowledge library entries', () => {
    it('does not read the library row until the menu opens', () => {
        render(
            <KbDocumentContextMenu workId="work-1" document={activeDoc}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        expect(client.getDocument).not.toHaveBeenCalled();
    });

    it('adds File and Export beside the existing entries, and no Restore for an active document', async () => {
        renderMenu();

        expect(screen.getByTestId('kb-workbench-context-archive')).toBeTruthy();
        await waitFor(() =>
            expect(
                screen.getByTestId('kb-workbench-context-file').getAttribute('data-disabled'),
            ).toBe('false'),
        );
        expect(
            screen.getByTestId('kb-workbench-context-export').getAttribute('data-disabled'),
        ).toBe('false');
        expect(screen.queryByTestId('kb-workbench-context-restore')).toBeNull();
    });

    it('explains, in the menu, why File and Export are off in the personal workspace', async () => {
        scopeMock.mockReturnValue({ kind: 'personal' });
        renderMenu();

        expect((await screen.findByTestId('kb-workbench-context-file-hint')).textContent).toBe(
            'needsOrganization',
        );
        expect(screen.getByTestId('kb-workbench-context-export-hint').textContent).toBe(
            'needsOrganization',
        );
        expect(client.getDocument).not.toHaveBeenCalled();
    });

    it('shows a view-only member the edit-access reason for File and Restore', async () => {
        client.getDocument.mockResolvedValue(libraryDoc({ canEdit: false, status: 'archived' }));
        renderMenu({ ...activeDoc, status: 'archived' });

        expect((await screen.findByTestId('kb-workbench-context-file-hint')).textContent).toBe(
            'noEditAccessFile',
        );
        expect(screen.getByTestId('kb-workbench-context-restore-hint').textContent).toBe(
            'noEditAccessRestore',
        );
    });

    it('restores an archived document through the Work and refreshes the tree', async () => {
        unarchiveMock.mockResolvedValue({
            success: true,
            data: { document: { ...activeDoc, status: 'active' }, restoredToUnfiled: false },
        });
        renderMenu({ ...activeDoc, status: 'archived' });

        fireEvent.click(await screen.findByTestId('kb-workbench-context-restore'));

        await waitFor(() =>
            expect(unarchiveMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'playbooks/refund.md',
            }),
        );
        expect(routerRefresh).toHaveBeenCalled();
    });

    it('shows the menu error when a restore fails', async () => {
        unarchiveMock.mockResolvedValue({ success: false, error: undefined });
        renderMenu({ ...activeDoc, status: 'archived' });

        fireEvent.click(await screen.findByTestId('kb-workbench-context-restore'));

        expect((await screen.findByTestId('kb-workbench-context-menu-error')).textContent).toBe(
            'restoreFailed',
        );
    });

    it('opens the folder picker from File into folder…', async () => {
        client.file.mockResolvedValue({ filed: 1, folderId: 'playbooks' });
        renderMenu();

        await waitFor(() =>
            expect(
                screen.getByTestId('kb-workbench-context-file').getAttribute('data-disabled'),
            ).toBe('false'),
        );
        fireEvent.click(screen.getByTestId('kb-workbench-context-file'));
        fireEvent.click(await screen.findByTestId('library-folder-picker-option-playbooks'));
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        await waitFor(() => expect(client.file).toHaveBeenCalledWith(['doc-1'], 'playbooks'));
    });

    it('exports Markdown from the menu', async () => {
        client.exportMarkdown.mockResolvedValue(undefined);
        renderMenu();

        await waitFor(() =>
            expect(
                screen.getByTestId('kb-workbench-context-export').getAttribute('data-disabled'),
            ).toBe('false'),
        );
        fireEvent.click(screen.getByTestId('kb-workbench-context-export'));

        await waitFor(() =>
            expect(client.exportMarkdown).toHaveBeenCalledWith('doc-1', 'refund.md'),
        );
    });
});

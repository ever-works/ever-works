import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KbDocumentDto } from '@ever-works/contracts';
import { libraryDoc, libraryTree } from './__tests__/library-fixtures';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const { scopeMock, toastMock, client, actions, routerRefresh } = vi.hoisted(() => ({
    scopeMock: vi.fn(() => ({ kind: 'organization', slug: 'ever' }) as unknown),
    toastMock: { success: vi.fn(), error: vi.fn() },
    client: {
        getDocument: vi.fn(),
        tree: vi.fn(),
        file: vi.fn(),
        createFolder: vi.fn(),
        exportMarkdown: vi.fn(),
    },
    actions: { archive: vi.fn(), unarchive: vi.fn() },
    routerRefresh: vi.fn(),
}));

vi.mock('@/lib/hooks/use-workspace-scope', () => ({ useWorkspaceScope: scopeMock }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }));
vi.mock('@/app/actions/works/kb-review', () => ({
    archiveKbDocumentAction: actions.archive,
    unarchiveKbDocumentAction: actions.unarchive,
}));
vi.mock('./library-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./library-client')>()),
    knowledgeLibraryClient: client,
}));

import { DocumentShelfControls } from './DocumentShelfControls';

const doc = libraryDoc() as unknown as KbDocumentDto;

beforeEach(() => {
    for (const fn of [...Object.values(client), actions.archive, actions.unarchive]) {
        fn.mockReset();
    }
    scopeMock.mockReturnValue({ kind: 'organization', slug: 'ever' });
    client.getDocument.mockResolvedValue(libraryDoc());
    client.tree.mockResolvedValue(libraryTree());
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    routerRefresh.mockReset();
});

afterEach(cleanup);

describe('DocumentShelfControls', () => {
    it('shows the folder breadcrumb and enables every control for an editor', async () => {
        render(<DocumentShelfControls workId="work-1" document={doc} />);

        expect((await screen.findByTestId('kb-workbench-folder-breadcrumb')).textContent).toBe(
            'Playbooks / Support',
        );
        for (const id of [
            'kb-workbench-file-button',
            'kb-workbench-archive-button',
            'kb-workbench-export-button',
        ]) {
            expect(screen.getByTestId(id).getAttribute('aria-disabled')).toBe('false');
        }
        expect(client.getDocument).toHaveBeenCalledWith('doc-1', expect.anything());
    });

    it('keeps File, Archive and Export visible but disabled, with the exact copy, for a viewer', async () => {
        client.getDocument.mockResolvedValue(libraryDoc({ canEdit: false }));
        render(<DocumentShelfControls workId="work-1" document={doc} />);

        await waitFor(() =>
            expect(screen.getByTestId('kb-workbench-file-button').getAttribute('title')).toBe(
                'noEditAccessFile',
            ),
        );
        const archive = screen.getByTestId('kb-workbench-archive-button');
        expect(archive.getAttribute('aria-disabled')).toBe('true');
        expect(archive.getAttribute('title')).toBe('noEditAccessArchive');
        fireEvent.click(archive);
        expect(actions.archive).not.toHaveBeenCalled();
        // Export needs only view access.
        expect(screen.getByTestId('kb-workbench-export-button').getAttribute('aria-disabled')).toBe(
            'false',
        );
    });

    it('in the personal workspace, disables File and Export with the reason and never asks the library', async () => {
        scopeMock.mockReturnValue({ kind: 'personal' });
        render(<DocumentShelfControls workId="work-1" document={doc} />);

        await waitFor(() =>
            expect(
                screen.getByTestId('kb-workbench-file-button').getAttribute('data-disabled-reason'),
            ).toBe('needsOrganization'),
        );
        expect(
            screen.getByTestId('kb-workbench-export-button').getAttribute('data-disabled-reason'),
        ).toBe('needsOrganization');
        expect(screen.queryByTestId('kb-workbench-folder-breadcrumb')).toBeNull();
        expect(client.getDocument).not.toHaveBeenCalled();
        // Archive goes through the Work's own endpoint, so it stays usable.
        expect(
            screen.getByTestId('kb-workbench-archive-button').getAttribute('aria-disabled'),
        ).toBe('false');
    });

    it('treats a document the library cannot read like the personal workspace', async () => {
        client.getDocument.mockRejectedValue(new Error('404'));
        render(<DocumentShelfControls workId="work-1" document={doc} />);

        await waitFor(() =>
            expect(
                screen
                    .getByTestId('kb-workbench-shelf-controls')
                    .getAttribute('data-library-state'),
            ).toBe('unavailable'),
        );
        expect(
            screen.getByTestId('kb-workbench-file-button').getAttribute('data-disabled-reason'),
        ).toBe('needsOrganization');
    });

    it('archives through the Work and then offers Restore', async () => {
        actions.archive.mockResolvedValue({ success: true, data: { ...doc, status: 'archived' } });
        render(<DocumentShelfControls workId="work-1" document={doc} />);
        await screen.findByTestId('kb-workbench-folder-breadcrumb');

        fireEvent.click(screen.getByTestId('kb-workbench-archive-button'));

        await waitFor(() =>
            expect(actions.archive).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'playbooks/refund.md',
            }),
        );
        expect(await screen.findByTestId('kb-workbench-restore-button')).toBeTruthy();
        expect(toastMock.success).toHaveBeenCalledWith('archivedToast:{"title":"Refund policy"}');
        expect(routerRefresh).toHaveBeenCalled();
    });

    it('restores an archived document and says it landed in Unfiled when its folder is gone', async () => {
        actions.unarchive.mockResolvedValue({
            success: true,
            data: { document: { ...doc, status: 'active' }, restoredToUnfiled: true },
        });
        const archived = { ...doc, status: 'archived' } as KbDocumentDto;
        render(<DocumentShelfControls workId="work-1" document={archived} />);
        await screen.findByTestId('kb-workbench-folder-breadcrumb');

        fireEvent.click(screen.getByTestId('kb-workbench-restore-button'));

        await waitFor(() =>
            expect(toastMock.success).toHaveBeenCalledWith(
                'restoredToUnfiledToast:{"title":"Refund policy"}',
            ),
        );
        expect(await screen.findByTestId('kb-workbench-archive-button')).toBeTruthy();
    });

    it('reports a failed archive without changing the control', async () => {
        actions.archive.mockResolvedValue({ success: false, error: 'nope' });
        render(<DocumentShelfControls workId="work-1" document={doc} />);
        await screen.findByTestId('kb-workbench-folder-breadcrumb');

        fireEvent.click(screen.getByTestId('kb-workbench-archive-button'));

        await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('archiveFailed'));
        expect(screen.getByTestId('kb-workbench-archive-button')).toBeTruthy();
    });

    it('files from the header through the folder picker', async () => {
        client.file.mockResolvedValue({ filed: 1, folderId: null });
        render(<DocumentShelfControls workId="work-1" document={doc} />);
        await screen.findByTestId('kb-workbench-folder-breadcrumb');

        fireEvent.click(screen.getByTestId('kb-workbench-file-button'));
        fireEvent.click(await screen.findByTestId('library-folder-picker-unfiled'));
        fireEvent.click(screen.getByTestId('library-folder-picker-confirm'));

        await waitFor(() => expect(client.file).toHaveBeenCalledWith(['doc-1'], null));
        expect(toastMock.success).toHaveBeenCalledWith('unfiledToast:{"count":1}');
    });

    it('exports Markdown, reporting a failure', async () => {
        client.exportMarkdown.mockRejectedValue(new Error('boom'));
        render(<DocumentShelfControls workId="work-1" document={doc} />);
        await screen.findByTestId('kb-workbench-folder-breadcrumb');

        fireEvent.click(screen.getByTestId('kb-workbench-export-button'));

        await waitFor(() =>
            expect(client.exportMarkdown).toHaveBeenCalledWith('doc-1', 'refund.md'),
        );
        await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('exportFailed'));
    });
});

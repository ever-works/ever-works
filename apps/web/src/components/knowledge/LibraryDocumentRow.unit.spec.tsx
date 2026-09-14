import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { KbLibraryDocumentDto } from '@ever-works/contracts';
import { libraryDoc } from './__tests__/library-fixtures';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import { LibraryDocumentRow } from './LibraryDocumentRow';

function renderRow(doc: KbLibraryDocumentDto, selected = false) {
    const handlers = {
        onToggleSelect: vi.fn(),
        onFile: vi.fn(),
        onArchive: vi.fn(),
        onExport: vi.fn(),
    };
    render(<LibraryDocumentRow document={doc} selected={selected} {...handlers} />);
    return handlers;
}

afterEach(cleanup);

describe('LibraryDocumentRow', () => {
    it('links the title to the workbench and shows the folder breadcrumb and Work', () => {
        renderRow(libraryDoc());

        const title = screen.getByTestId('library-doc-title-doc-1');
        expect(title.getAttribute('href')).toBe('/works/work-1/kb/playbooks/refund.md');
        expect(screen.getByTestId('library-doc-folder-doc-1').textContent).toContain(
            'Playbooks / Support',
        );
        expect(screen.getByText('Support desk')).toBeTruthy();
        expect(screen.getByText(/changedAt/)).toBeTruthy();
    });

    it('reads as Unfiled with no folder, and an organization document has no workbench link', () => {
        renderRow(libraryDoc({ folderId: null, folderPath: null, workId: null, workName: null }));

        expect(screen.getByTestId('library-doc-folder-doc-1').textContent).toContain('unfiled');
        expect(screen.getByTestId('library-doc-title-doc-1').tagName).toBe('SPAN');
        expect(screen.getByText('orgScoped')).toBeTruthy();
    });

    it('files, exports and archives for an editor', () => {
        const doc = libraryDoc();
        const { onFile, onArchive, onExport, onToggleSelect } = renderRow(doc);

        fireEvent.click(screen.getByTestId('library-doc-file-doc-1'));
        expect(onFile).toHaveBeenCalledWith(doc);

        fireEvent.click(screen.getByTestId('library-doc-menu-doc-1'));
        fireEvent.click(screen.getByTestId('library-doc-export-doc-1'));
        expect(onExport).toHaveBeenCalledWith(doc);

        fireEvent.click(screen.getByTestId('library-doc-menu-doc-1'));
        fireEvent.click(screen.getByTestId('library-doc-archive-doc-1'));
        expect(onArchive).toHaveBeenCalledWith(doc);

        fireEvent.click(screen.getByTestId('library-doc-select-doc-1'));
        expect(onToggleSelect).toHaveBeenCalledWith('doc-1');
    });

    it('shows File and Archive disabled with the exact reason to a view-only member', () => {
        const { onFile, onArchive, onExport } = renderRow(libraryDoc({ canEdit: false }));

        const file = screen.getByTestId('library-doc-file-doc-1');
        expect(file.getAttribute('aria-disabled')).toBe('true');
        expect(file.getAttribute('title')).toBe('noEditAccessFile');
        fireEvent.click(file);

        fireEvent.click(screen.getByTestId('library-doc-menu-doc-1'));
        const archive = screen.getByTestId('library-doc-archive-doc-1');
        expect(archive.getAttribute('aria-disabled')).toBe('true');
        expect(archive.getAttribute('title')).toBe('noEditAccessArchive');
        fireEvent.click(archive);

        // Export needs only view access.
        fireEvent.click(screen.getByTestId('library-doc-export-doc-1'));

        expect(onFile).not.toHaveBeenCalled();
        expect(onArchive).not.toHaveBeenCalled();
        expect(onExport).toHaveBeenCalled();
    });

    it('files with f and archives with a on the focused row, never for a viewer', () => {
        const doc = libraryDoc();
        const { onFile, onArchive } = renderRow(doc);
        const row = screen.getByTestId('library-doc-doc-1');

        fireEvent.keyDown(row, { key: 'f' });
        fireEvent.keyDown(row, { key: 'a' });
        expect(onFile).toHaveBeenCalledTimes(1);
        expect(onArchive).toHaveBeenCalledTimes(1);
        cleanup();

        const viewer = renderRow(libraryDoc({ canEdit: false }));
        fireEvent.keyDown(screen.getByTestId('library-doc-doc-1'), { key: 'f' });
        expect(viewer.onFile).not.toHaveBeenCalled();
    });

    it('closes the overflow menu on Escape', () => {
        renderRow(libraryDoc());

        fireEvent.click(screen.getByTestId('library-doc-menu-doc-1'));
        expect(screen.getByTestId('library-doc-menu-panel-doc-1')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('library-doc-menu-panel-doc-1')).toBeNull();
    });
});

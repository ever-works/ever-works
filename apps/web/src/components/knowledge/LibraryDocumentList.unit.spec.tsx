import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { libraryDoc } from './__tests__/library-fixtures';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import { LibraryDocumentList, type LibraryDocumentListProps } from './LibraryDocumentList';

function renderList(props: Partial<LibraryDocumentListProps> = {}) {
    const handlers = {
        onToggleSelect: vi.fn(),
        onClearSelection: vi.fn(),
        onFileSelected: vi.fn(),
        onFile: vi.fn(),
        onArchive: vi.fn(),
        onExport: vi.fn(),
        onLoadMore: vi.fn(),
    };
    render(
        <LibraryDocumentList
            documents={[libraryDoc({ id: 'a' }), libraryDoc({ id: 'b', title: 'Voice guide' })]}
            selectedIds={new Set()}
            hasMore={false}
            isLoadingMore={false}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

afterEach(cleanup);

describe('LibraryDocumentList', () => {
    it('renders one row per document and no selection bar or paging by default', () => {
        renderList();

        expect(screen.getByTestId('library-doc-a')).toBeTruthy();
        expect(screen.getByTestId('library-doc-b')).toBeTruthy();
        expect(screen.queryByTestId('library-selection-bar')).toBeNull();
        expect(screen.queryByTestId('library-load-more')).toBeNull();
    });

    it('offers bulk filing for a selection and clears it', () => {
        const { onFileSelected, onClearSelection } = renderList({ selectedIds: new Set(['a']) });

        expect(screen.getByTestId('library-selection-bar').textContent).toContain(
            'selectedCount:{"count":1}',
        );
        fireEvent.click(screen.getByTestId('library-selection-file'));
        expect(onFileSelected).toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('library-selection-clear'));
        expect(onClearSelection).toHaveBeenCalled();
    });

    it('refuses a selection over 100 documents with the batch copy', () => {
        const documents = Array.from({ length: 143 }, (_v, i) => libraryDoc({ id: `d${i}` }));
        const { onFileSelected } = renderList({
            documents,
            selectedIds: new Set(documents.map((d) => d.id)),
        });

        expect(screen.getByTestId('library-selection-over-limit').textContent).toContain(
            'fileBatchLimit:{"max":100,"count":143}',
        );
        const file = screen.getByTestId('library-selection-file');
        expect(file.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(file);
        expect(onFileSelected).not.toHaveBeenCalled();
    });

    it('blocks bulk filing, with the reason, when a selected document is not editable', () => {
        const { onFileSelected } = renderList({
            documents: [libraryDoc({ id: 'a', canEdit: false })],
            selectedIds: new Set(['a']),
        });

        const file = screen.getByTestId('library-selection-file');
        expect(file.getAttribute('title')).toBe('noEditAccessFile');
        fireEvent.click(file);
        expect(onFileSelected).not.toHaveBeenCalled();
    });

    it('loads the next page from the Load more button', () => {
        const { onLoadMore } = renderList({ hasMore: true });

        fireEvent.click(screen.getByTestId('library-load-more'));
        expect(onLoadMore).toHaveBeenCalled();
    });

    it('disables Load more while a page is loading', () => {
        renderList({ hasMore: true, isLoadingMore: true });
        expect((screen.getByTestId('library-load-more') as HTMLButtonElement).disabled).toBe(true);
    });
});

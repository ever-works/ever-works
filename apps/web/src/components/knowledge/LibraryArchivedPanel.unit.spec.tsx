import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { libraryDoc } from './__tests__/library-fixtures';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
    useLocale: () => 'en-US',
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import { LibraryArchivedPanel, type LibraryArchivedPanelProps } from './LibraryArchivedPanel';

const archived = libraryDoc({
    id: 'old',
    title: 'Old refund policy',
    status: 'archived',
    archivedAt: '2026-08-04T00:00:00Z',
    folderPath: '/Playbooks',
});

function renderPanel(props: Partial<LibraryArchivedPanelProps> = {}) {
    const handlers = {
        onLoadMore: vi.fn(),
        onRetry: vi.fn(),
        onRestore: vi.fn(),
        onExport: vi.fn(),
    };
    render(
        <LibraryArchivedPanel
            documents={[archived]}
            total={9}
            state="ready"
            hasMore={false}
            isLoadingMore={false}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

afterEach(cleanup);

describe('LibraryArchivedPanel', () => {
    it('explains the view and lists archived documents with Restore and Export', () => {
        const { onRestore, onExport } = renderPanel();

        expect(screen.getByText('archivedSubtitle')).toBeTruthy();
        expect(screen.getByTestId('library-archived-count').textContent).toBe(
            'documentCount:{"count":9}',
        );
        const row = screen.getByTestId('library-archived-doc-old');
        expect(row.textContent).toContain('Playbooks');
        expect(row.textContent).toContain('archivedAt');

        fireEvent.click(screen.getByTestId('library-archived-restore-old'));
        expect(onRestore).toHaveBeenCalledWith(archived);
        fireEvent.click(screen.getByTestId('library-archived-export-old'));
        expect(onExport).toHaveBeenCalledWith(archived);
    });

    it('shows the empty copy when nothing is archived', () => {
        renderPanel({ documents: [], total: 0 });
        expect(screen.getByTestId('library-archived-empty').textContent).toBe('archivedEmpty');
    });

    it('offers a retry when the archived list fails to load', () => {
        const { onRetry } = renderPanel({ documents: [], state: 'error' });

        expect(screen.getByTestId('library-archived-error').textContent).toContain('loadFailed');
        fireEvent.click(screen.getByText('tryAgain'));
        expect(onRetry).toHaveBeenCalled();
    });

    it('shows a loading state instead of stale rows', () => {
        renderPanel({ state: 'loading' });
        expect(screen.getByTestId('library-archived-loading')).toBeTruthy();
        expect(screen.queryByTestId('library-archived-doc-old')).toBeNull();
    });

    it('keeps Restore visible but disabled, with the reason, for a view-only member', () => {
        const { onRestore } = renderPanel({ documents: [{ ...archived, canEdit: false }] });

        const restore = screen.getByTestId('library-archived-restore-old');
        expect(restore.getAttribute('aria-disabled')).toBe('true');
        expect(restore.getAttribute('title')).toBe('noEditAccessRestore');
        fireEvent.click(restore);
        expect(onRestore).not.toHaveBeenCalled();
    });

    it('pages with Load more', () => {
        const { onLoadMore } = renderPanel({ hasMore: true });
        fireEvent.click(screen.getByTestId('library-archived-load-more'));
        expect(onLoadMore).toHaveBeenCalled();
    });
});

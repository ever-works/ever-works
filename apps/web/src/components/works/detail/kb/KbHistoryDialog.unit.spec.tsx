import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
}));

const { routerRefreshMock } = vi.hoisted(() => ({ routerRefreshMock: vi.fn() }));
// KbHistoryDialog now imports `useRouter` from `@/i18n/navigation`
// (locale-aware variant). The `next/navigation` mock below stays in
// place as dead-code protection in case any transitive import still
// pulls it in. The hoisted ref lets both mocks share the same spy.
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: routerRefreshMock }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: routerRefreshMock,
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    redirect: vi.fn(),
    getPathname: ({ href }: { href: string }) => href,
}));

vi.mock('@/components/ui/button', () => ({
    Button: ({
        children,
        onClick,
        disabled,
        ...rest
    }: {
        children: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
    } & Record<string, unknown>) => (
        <button type="button" onClick={onClick} disabled={disabled} {...rest}>
            {children}
        </button>
    ),
}));

// date-fns is fine to keep — it's deterministic given a fixed reference
// date, but the spec doesn't care about the formatted output, only
// that the commit's `authoredAt` is rendered somewhere in the row.

const getActionMock = vi.fn();
const restoreActionMock = vi.fn();
vi.mock('@/app/actions/works/kb-history', () => ({
    getKbDocumentHistoryAction: (...args: unknown[]) => getActionMock(...args),
    restoreKbDocumentAction: (...args: unknown[]) => restoreActionMock(...args),
}));

import { KbHistoryDialog } from './KbHistoryDialog';

const sampleCommits = [
    {
        sha: 'abc1234567890abcdef',
        message: 'Edit brand voice intro',
        authorName: 'Ada Lovelace',
        authoredAt: '2026-05-20T10:00:00Z',
    },
    {
        sha: 'def5678901234567890',
        message: 'Fix typo',
        authorName: 'Grace Hopper',
        authoredAt: '2026-05-19T08:30:00Z',
    },
];

/**
 * EW-641 Phase 1B/d row 18c — restore-from-history dialog tests.
 *
 * Pins:
 *  - dialog doesn't render when `open=false`
 *  - on open: fetches history via the server action
 *  - empty state when items.length === 0
 *  - error state when the action returns `success: false`
 *  - row click highlights the row + enables the confirm button
 *  - confirm click POSTs to restoreKbDocumentAction with the right
 *    args + closes the dialog on success
 *  - escape via the close button calls onClose
 */
describe('KbHistoryDialog', () => {
    beforeEach(() => {
        getActionMock.mockReset();
        restoreActionMock.mockReset();
        routerRefreshMock.mockReset();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders nothing when open=false', () => {
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open={false}
                onClose={() => undefined}
            />,
        );
        expect(screen.queryByTestId('kb-history-dialog')).toBeNull();
        expect(getActionMock).not.toHaveBeenCalled();
    });

    it('fetches on open and renders the loading state then the rows', async () => {
        getActionMock.mockResolvedValueOnce({ success: true, data: { items: sampleCommits } });
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={() => undefined}
            />,
        );
        // Loading state appears synchronously after mount.
        expect(screen.getByTestId('kb-history-loading')).toBeTruthy();
        await waitFor(() => {
            expect(screen.queryByTestId('kb-history-loading')).toBeNull();
        });
        expect(getActionMock).toHaveBeenCalledWith({ workId: 'work-1', docId: 'doc-1' });
        const rows = screen.getAllByTestId('kb-history-row');
        expect(rows.length).toBe(2);
        expect(rows[0].getAttribute('data-sha')).toBe('abc1234567890abcdef');
        expect(rows[0].getAttribute('data-active')).toBe('false');
        expect(rows[0].textContent).toContain('abc1234'); // short sha
        expect(rows[0].textContent).toContain('Edit brand voice intro');
        expect(rows[0].textContent).toContain('Ada Lovelace');
    });

    it('renders the empty state when items.length === 0', async () => {
        getActionMock.mockResolvedValueOnce({ success: true, data: { items: [] } });
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={() => undefined}
            />,
        );
        await waitFor(() => {
            expect(screen.getByTestId('kb-history-empty')).toBeTruthy();
        });
        // Restore footer shouldn't render when there are no commits.
        expect(screen.queryByTestId('kb-history-restore-confirm')).toBeNull();
    });

    it('renders the error state when the action returns success:false', async () => {
        getActionMock.mockResolvedValueOnce({ success: false, error: 'upstream 503' });
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={() => undefined}
            />,
        );
        await waitFor(() => {
            expect(screen.getByTestId('kb-history-error').textContent).toContain('upstream 503');
        });
    });

    it('clicking a row highlights it + enables the confirm button', async () => {
        getActionMock.mockResolvedValueOnce({ success: true, data: { items: sampleCommits } });
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={() => undefined}
            />,
        );
        await waitFor(() => expect(screen.getAllByTestId('kb-history-row').length).toBe(2));

        const confirm = screen.getByTestId('kb-history-restore-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        fireEvent.click(screen.getAllByTestId('kb-history-row')[1]);
        expect(screen.getAllByTestId('kb-history-row')[1].getAttribute('data-active')).toBe('true');
        expect(confirm.disabled).toBe(false);
    });

    it('confirm posts to restoreKbDocumentAction and closes the dialog on success', async () => {
        getActionMock.mockResolvedValueOnce({ success: true, data: { items: sampleCommits } });
        restoreActionMock.mockResolvedValueOnce({ success: true, data: {} });
        const onClose = vi.fn();
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={onClose}
            />,
        );
        await waitFor(() => expect(screen.getAllByTestId('kb-history-row').length).toBe(2));
        fireEvent.click(screen.getAllByTestId('kb-history-row')[0]);
        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-history-restore-confirm'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(restoreActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            path: 'brand/voice.md',
            commitSha: 'abc1234567890abcdef',
        });
        await waitFor(() => {
            expect(routerRefreshMock).toHaveBeenCalled();
            expect(onClose).toHaveBeenCalled();
        });
    });

    it('surfaces the restore error and keeps the dialog open', async () => {
        getActionMock.mockResolvedValueOnce({ success: true, data: { items: sampleCommits } });
        restoreActionMock.mockResolvedValueOnce({ success: false, error: 'forbidden' });
        const onClose = vi.fn();
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={onClose}
            />,
        );
        await waitFor(() => expect(screen.getAllByTestId('kb-history-row').length).toBe(2));
        fireEvent.click(screen.getAllByTestId('kb-history-row')[0]);
        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-history-restore-confirm'));
            await Promise.resolve();
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(screen.getByTestId('kb-history-restore-error').textContent).toContain(
                'forbidden',
            );
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes via the close button', () => {
        getActionMock.mockResolvedValueOnce({ success: true, data: { items: [] } });
        const onClose = vi.fn();
        render(
            <KbHistoryDialog
                workId="work-1"
                docId="doc-1"
                path="brand/voice.md"
                open
                onClose={onClose}
            />,
        );
        fireEvent.click(screen.getByTestId('kb-history-close'));
        expect(onClose).toHaveBeenCalled();
    });
});

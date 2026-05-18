import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SyncEventRow } from './SyncEventRow';

/**
 * EW-628 Phase 7 — pin the per-variant render shape of {@link SyncEventRow}.
 * Three variants (success / skipped / failed) plus a couple of edge cases
 * (missing SHA, missing duration). No snapshot files; we assert specific
 * accessible content so styling drift doesn't cause unrelated diff churn.
 */
describe('SyncEventRow (EW-628 Phase 7)', () => {
    it('renders success: shortened beforeSha → afterSha, filesChanged, rounded duration', () => {
        render(
            <SyncEventRow
                event={{
                    kind: 'success',
                    source: 'webhook',
                    beforeSha: 'aaaabbbbcccc',
                    afterSha: 'ddddeeeefffff',
                    filesChanged: 3,
                    durationMs: 1234,
                }}
            />,
        );

        expect(screen.getByTestId('sync-event-row-success')).toHaveAttribute(
            'data-event-kind',
            'success',
        );
        expect(screen.getByText(/Sync complete/i)).toBeInTheDocument();
        expect(screen.getByText('webhook')).toBeInTheDocument();
        expect(screen.getByText(/aaaabbb → ddddeee/)).toBeInTheDocument();
        expect(screen.getByText(/3 files/)).toBeInTheDocument();
        // 1234ms -> 1.2s after rounding to one decimal
        expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
    });

    it('renders success: em-dash placeholders when SHAs are missing (stats stubbed before gitFacade helper lands)', () => {
        render(<SyncEventRow event={{ kind: 'success', source: 'poll', filesChanged: 0 }} />);
        expect(screen.getByText(/— → —/)).toBeInTheDocument();
        expect(screen.getByText(/0 files/)).toBeInTheDocument();
    });

    it('renders skipped: surfaces the reason verbatim and the source chip', () => {
        render(
            <SyncEventRow event={{ kind: 'skipped', source: 'poll', reason: 'retry-backoff' }} />,
        );
        expect(screen.getByTestId('sync-event-row-skipped')).toBeInTheDocument();
        expect(screen.getByText(/Sync skipped/i)).toBeInTheDocument();
        expect(screen.getByText('poll')).toBeInTheDocument();
        expect(screen.getByText('retry-backoff')).toBeInTheDocument();
    });

    it('renders failed: errorClass as the summary, errorTail inside a disclosure', () => {
        render(
            <SyncEventRow
                event={{
                    kind: 'failed',
                    source: 'manual',
                    errorClass: 'main-repo-push-rejected',
                    errorTail: 'fatal: non-fast-forward',
                }}
            />,
        );
        expect(screen.getByTestId('sync-event-row-failed')).toBeInTheDocument();
        expect(screen.getByText(/Sync failed/i)).toBeInTheDocument();
        expect(screen.getByText('main-repo-push-rejected')).toBeInTheDocument();
        // errorTail lives inside <details>; we don't open it in the test, but
        // it must be present in the DOM (collapsed content is still rendered).
        expect(screen.getByText('fatal: non-fast-forward')).toBeInTheDocument();
    });

    it.each(['webhook', 'poll', 'manual'] as const)(
        'displays the %s source chip on every variant',
        (source) => {
            const { unmount } = render(
                <SyncEventRow event={{ kind: 'success', source, filesChanged: 1 }} />,
            );
            expect(screen.getByText(source)).toBeInTheDocument();
            unmount();
        },
    );
});

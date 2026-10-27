import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { UpstreamPullRequestView } from '@ever-works/contracts';
import messages from '../../../../../messages/en.json';
import { UpstreamPullRequestsSection, safeUpstreamUrl } from './UpstreamPullRequestsSection';

/**
 * APW-09 — the Upstream tab's **Upstream pull requests** section, rendered with the REAL
 * English catalogue: the list, its empty state, a failed read that is never shown as "none",
 * the private-copy notice, the state chip, the link, the draft and direct markers, and the
 * refusal copy of a refused record.
 */

function row(over: Partial<UpstreamPullRequestView> = {}): UpstreamPullRequestView {
    return {
        id: 'r1',
        sourceTaskId: 't1',
        userId: 'u1',
        origin: 'direct',
        state: 'open',
        upstream: { owner: 'acme', repo: 'bookings', baseBranch: 'main' },
        head: { owner: 'maya', repo: 'bookings', branch: 'ever-works/t-1', sha: null },
        number: 12,
        url: 'https://github.com/acme/bookings/pull/12',
        draft: true,
        title: 'Add an SMS reminder',
        body: null,
        disclosureText: null,
        maintainerCanModify: true,
        checksSummary: null,
        reviewSummary: null,
        signatureState: null,
        refusalCode: null,
        refusalDetail: null,
        diffStats: null,
        extraFilesAcknowledgedAt: null,
        approvalProposalId: null,
        approvalExpiresAt: null,
        openedAt: '2026-10-27T10:00:00.000Z',
        mergedAt: null,
        closedAt: null,
        lastUpstreamActivityAt: null,
        nextCheckAt: null,
        createdAt: '2026-10-27T09:59:00.000Z',
        updatedAt: '2026-10-27T10:00:00.000Z',
        ...over,
    };
}

function renderSection(props: Parameters<typeof UpstreamPullRequestsSection>[0]) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <UpstreamPullRequestsSection {...props} />
        </NextIntlClientProvider>,
    );
}

afterEach(() => cleanup());

describe('UpstreamPullRequestsSection (APW-09)', () => {
    it('lists a record with its state, link, draft and direct markers, head and UTC time', () => {
        renderSection({ rows: [row()], relation: 'fork', upstream: 'acme/bookings' });
        const item = screen.getByTestId('upstream-pull-request-row');
        expect(item).toHaveAttribute('data-state', 'open');
        expect(within(item).getByText('Open')).toBeInTheDocument();
        const link = within(item).getByRole('link');
        expect(link).toHaveAttribute('href', 'https://github.com/acme/bookings/pull/12');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link.textContent).toContain('acme/bookings#12');
        expect(within(item).getByText('Draft')).toBeInTheDocument();
        expect(within(item).getByText('Opened directly')).toBeInTheDocument();
        expect(item.textContent).toContain('maya:ever-works/t-1');
        expect(item.textContent).toContain('UTC');
    });

    it('shows the refusal copy of a refused record, never the raw code', () => {
        renderSection({
            rows: [row({ state: 'refused', url: null, number: null, refusalCode: 'rateLimited' })],
            relation: 'fork',
            upstream: 'acme/bookings',
        });
        expect(screen.getByTestId('upstream-pull-request-refusal').textContent).toContain(
            'You can open 1 pull request on acme/bookings per day.',
        );
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('renders only an https URL as a link', () => {
        expect(safeUpstreamUrl('https://github.com/acme/bookings/pull/12')).toBe(
            'https://github.com/acme/bookings/pull/12',
        );
        expect(safeUpstreamUrl('javascript:alert(1)')).toBeNull();
        expect(safeUpstreamUrl('/relative')).toBeNull();
        expect(safeUpstreamUrl(null)).toBeNull();
        renderSection({
            rows: [row({ url: 'javascript:alert(1)' })],
            relation: 'fork',
            upstream: 'acme/bookings',
        });
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('says there are none — and only when the read succeeded', () => {
        renderSection({ rows: [], relation: 'fork', upstream: 'acme/bookings' });
        expect(screen.getByTestId('upstream-pull-requests-empty')).toBeInTheDocument();
        cleanup();
        renderSection({ rows: null, relation: 'fork', upstream: 'acme/bookings' });
        expect(screen.getByTestId('upstream-pull-requests-error')).toBeInTheDocument();
        expect(screen.queryByTestId('upstream-pull-requests-empty')).toBeNull();
    });

    it('explains a private copy (S10)', () => {
        renderSection({ rows: [], relation: 'private-copy', upstream: 'acme/bookings' });
        expect(screen.getByTestId('upstream-pull-requests-private-copy').textContent).toContain(
            "A private copy isn't connected to acme/bookings on GitHub",
        );
    });

    it('has a label for every state', () => {
        const states = (
            messages as {
                dashboard: {
                    workDetail: { upstream: { pullRequests: { states: Record<string, string> } } };
                };
            }
        ).dashboard.workDetail.upstream.pullRequests.states;
        expect(Object.keys(states).sort()).toEqual(
            [
                'preparing',
                'needs_signature',
                'awaiting_approval',
                'opening',
                'open',
                'merged',
                'closed',
                'refused',
                'failed',
                'expired',
                'withdrawn',
            ].sort(),
        );
    });
});

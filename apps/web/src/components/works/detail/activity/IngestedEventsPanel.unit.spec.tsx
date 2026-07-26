import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listMock = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useLocale: () => 'en',
}));
vi.mock('@/app/actions/works/pull-requests', () => ({
    listWorkIngestedEventsAction: (...args: unknown[]) => listMock(...args),
    listWorkPullRequestsAction: vi.fn(),
    getWorkPullRequestDiffAction: vi.fn(),
    requestWorkPullRequestReviewAction: vi.fn(),
}));

import { IngestedEventsPanel } from './IngestedEventsPanel';

const EVENTS = [
    {
        id: 'e1',
        source: 'github',
        kind: 'github.pr.review',
        occurredAt: '2026-07-25T10:00:00.000Z',
        actorName: 'ever-works-reviewer',
        title: 'Add the landing page',
        sourceUrl: 'https://git.example/octo/acme/pull/7',
        workId: 'work-1',
        processed: true,
    },
    {
        id: 'e2',
        source: 'jira-connector',
        kind: 'jira.issue',
        occurredAt: '2026-07-24T10:00:00.000Z',
        actorName: null,
        title: 'ENG-42 Fix the flux capacitor',
        sourceUrl: 'https://acme.atlassian.net/browse/ENG-42',
        workId: 'work-1',
        processed: true,
    },
];

/**
 * Wave 8 feature j — the per-Work external-activity feed. The
 * load-bearing behaviours: source filtering goes back to the SERVER (so
 * it stays correct past one page), the chip set survives a filtered
 * load, and every source link is noopener.
 */
describe('IngestedEventsPanel', () => {
    beforeEach(() => {
        listMock.mockReset();
        listMock.mockResolvedValue({ success: true, data: { data: EVENTS } });
    });

    it('loads this Work’s ingested events on mount', async () => {
        render(<IngestedEventsPanel workId="work-1" />);
        await waitFor(() => expect(screen.getByTestId('ingested-events-list')).toBeInTheDocument());
        expect(listMock).toHaveBeenCalledWith('work-1', { limit: 50 });
        expect(screen.getAllByTestId('ingested-event-row')).toHaveLength(2);
        const link = screen.getAllByTestId('ingested-event-source-link')[0];
        expect(link).toHaveAttribute('href', EVENTS[0].sourceUrl);
        expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('derives its source chips from the events actually present', async () => {
        render(<IngestedEventsPanel workId="work-1" initialEvents={EVENTS as never} />);
        await waitFor(() =>
            expect(screen.getByTestId('ingested-events-filters')).toBeInTheDocument(),
        );
        expect(screen.getByTestId('ingested-events-filter-github')).toBeInTheDocument();
        expect(screen.getByTestId('ingested-events-filter-jira-connector')).toBeInTheDocument();
        expect(screen.getByTestId('ingested-events-filter-all')).toBeInTheDocument();
    });

    it('re-queries the SERVER when a source chip is selected, keeping the chip row intact', async () => {
        const user = userEvent.setup();
        render(<IngestedEventsPanel workId="work-1" initialEvents={EVENTS as never} />);

        listMock.mockResolvedValueOnce({ success: true, data: { data: [EVENTS[1]] } });
        await user.click(screen.getByTestId('ingested-events-filter-jira-connector'));

        await waitFor(() =>
            expect(listMock).toHaveBeenCalledWith('work-1', {
                limit: 50,
                source: 'jira-connector',
            }),
        );
        await waitFor(() => expect(screen.getAllByTestId('ingested-event-row')).toHaveLength(1));
        // The chip row must not collapse to the selected source alone.
        expect(screen.getByTestId('ingested-events-filter-github')).toBeInTheDocument();
    });

    it('renders the filtered-empty copy when a source has no events', async () => {
        const user = userEvent.setup();
        render(<IngestedEventsPanel workId="work-1" initialEvents={EVENTS as never} />);

        listMock.mockResolvedValueOnce({ success: true, data: { data: [] } });
        await user.click(screen.getByTestId('ingested-events-filter-github'));

        await waitFor(() =>
            expect(screen.getByTestId('ingested-events-empty')).toHaveTextContent('emptyFiltered'),
        );
    });

    it('renders an error state instead of an empty feed when the fetch fails', async () => {
        listMock.mockResolvedValue({ success: false, error: 'spine unavailable' });
        render(<IngestedEventsPanel workId="work-1" />);
        await waitFor(() =>
            expect(screen.getByTestId('ingested-events-error')).toHaveTextContent(
                'spine unavailable',
            ),
        );
    });

    it('renders the unfiltered empty state when the Work has no external events', async () => {
        listMock.mockResolvedValue({ success: true, data: { data: [] } });
        render(<IngestedEventsPanel workId="work-1" />);
        await waitFor(() =>
            expect(screen.getByTestId('ingested-events-empty')).toHaveTextContent('empty'),
        );
    });
});

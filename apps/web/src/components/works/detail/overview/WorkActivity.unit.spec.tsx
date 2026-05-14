import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

const mockGetActivityFeed = vi.fn();
vi.mock('@/app/actions/dashboard/activity-feed', () => ({
    getActivityFeed: (...args: unknown[]) => mockGetActivityFeed(...args),
}));

import { WorkActivity } from './WorkActivity';

const baseResponse = (entries: unknown[]) => ({
    success: true as const,
    data: {
        entries,
        nextCursor: null,
        serverTime: '2026-05-13T00:00:00.000Z',
    },
});

describe('WorkActivity (overview widget)', () => {
    beforeEach(() => {
        mockGetActivityFeed.mockReset();
    });

    it('requests at most 5 entries from the aggregator', async () => {
        mockGetActivityFeed.mockResolvedValue(baseResponse([]));
        render(<WorkActivity workId="work-1" />);
        await waitFor(() => expect(mockGetActivityFeed).toHaveBeenCalled());
        expect(mockGetActivityFeed).toHaveBeenCalledWith('work-1', { limit: 5 });
    });

    it('shows empty state when there are no entries', async () => {
        mockGetActivityFeed.mockResolvedValue(baseResponse([]));
        render(<WorkActivity workId="work-1" />);
        await waitFor(() => {
            expect(screen.getByText('empty.title')).toBeInTheDocument();
        });
    });

    it('renders entries with summary and links to the full feed', async () => {
        mockGetActivityFeed.mockResolvedValue(
            baseResponse([
                {
                    id: 'h-1',
                    source: 'generation-history',
                    type: 'generation',
                    category: 'generation',
                    timestamp: '2026-05-13T00:00:00.000Z',
                    summary: 'Generation completed (12 added)',
                    status: 'completed',
                    runId: 'h-1',
                    newItemsCount: 12,
                    updatedItemsCount: 0,
                    totalItemsCount: 12,
                },
            ]),
        );

        render(<WorkActivity workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByText('Generation completed (12 added)')).toBeInTheDocument();
        });
        const viewAll = screen.getByRole('link', { name: /actions\.viewAll/ });
        expect(viewAll.getAttribute('href')).toBe('/works/work-1/activity');
    });
});

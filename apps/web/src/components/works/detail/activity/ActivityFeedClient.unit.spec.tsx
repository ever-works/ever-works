import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ replace: mockReplace }),
    usePathname: () => '/works/work-1/activity',
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('next/navigation', () => ({
    useSearchParams: () => mockSearchParams,
}));

const mockGetActivityFeed = vi.fn();
vi.mock('@/app/actions/dashboard/activity-feed', () => ({
    getActivityFeed: (...args: unknown[]) => mockGetActivityFeed(...args),
}));

import { ActivityFeedClient } from './ActivityFeedClient';

function emptySuccess(over: Record<string, unknown> = {}) {
    return {
        success: true as const,
        data: {
            entries: [],
            nextCursor: null,
            serverTime: '2026-05-13T00:00:00.000Z',
            ...over,
        },
    };
}

describe('ActivityFeedClient', () => {
    beforeEach(() => {
        mockReplace.mockReset();
        mockGetActivityFeed.mockReset();
    });

    it('renders the empty state when the API returns zero entries', async () => {
        mockGetActivityFeed.mockResolvedValue(emptySuccess());

        render(<ActivityFeedClient workId="work-1" initialCategory="all" />);

        await waitFor(() => {
            expect(screen.getByText('empty.title')).toBeInTheDocument();
        });
        expect(mockGetActivityFeed).toHaveBeenCalledWith(
            'work-1',
            expect.objectContaining({ category: 'all', limit: 25 }),
        );
    });

    it('surfaces the degraded banner when the API reports a pull-mode failure', async () => {
        // Phase 5 (EW-120 dual-mode): pull-mode degraded reasons come back in
        // `response.degraded.directorySite`. The banner uses its own scoped
        // `useTranslations('...activity.degraded')` namespace, so the mocked
        // `t(key)` echoes just the relative key.
        mockGetActivityFeed.mockResolvedValue(
            emptySuccess({
                degraded: {
                    directorySite: {
                        reason: 'timeout',
                        lastSuccessAt: '2026-05-12T10:00:00.000Z',
                    },
                },
            }),
        );

        render(<ActivityFeedClient workId="work-1" initialCategory="all" />);

        await waitFor(() => {
            expect(screen.getByRole('status')).toBeInTheDocument();
        });
        expect(screen.getByText('title.timeout')).toBeInTheDocument();
    });

    it('updates URL when filter chip is clicked', async () => {
        mockGetActivityFeed.mockResolvedValue(emptySuccess());

        render(<ActivityFeedClient workId="work-1" initialCategory="all" />);
        await waitFor(() => expect(mockGetActivityFeed).toHaveBeenCalledTimes(1));

        const usersChip = await screen.findByRole('tab', { name: 'users' });
        await userEvent.click(usersChip);

        expect(mockReplace).toHaveBeenCalled();
        const target = mockReplace.mock.calls[0][0] as string;
        expect(target).toContain('category=users');
    });

    it('surfaces an error message when the action returns failure', async () => {
        mockGetActivityFeed.mockResolvedValue({ success: false, error: 'API down' });

        render(<ActivityFeedClient workId="work-1" initialCategory="all" />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('API down');
        });
    });

    it('opens the initial category from props without forcing a URL update', async () => {
        mockGetActivityFeed.mockResolvedValue(emptySuccess());

        render(<ActivityFeedClient workId="work-1" initialCategory="deployment" />);

        await waitFor(() => {
            expect(mockGetActivityFeed).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({ category: 'deployment' }),
            );
        });
        // Mount must not call replace — only user-driven chip changes do.
        expect(mockReplace).not.toHaveBeenCalled();
    });
});

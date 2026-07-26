import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const diffMock = vi.fn();
const reviewMock = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useLocale: () => 'en',
}));
vi.mock('@/app/actions/works/pull-requests', () => ({
    getWorkPullRequestDiffAction: (...args: unknown[]) => diffMock(...args),
    requestWorkPullRequestReviewAction: (...args: unknown[]) => reviewMock(...args),
    listWorkPullRequestsAction: vi.fn(),
    listWorkIngestedEventsAction: vi.fn(),
}));

import { PullRequestDiffPanel } from './PullRequestDiffPanel';

const PR = {
    number: 7,
    title: 'Add the landing page',
    state: 'open' as const,
    head: 'feat/landing',
    base: 'main',
    url: 'https://git.example/octo/acme/pull/7',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
};

function diffPayload(overrides: Record<string, unknown> = {}) {
    return {
        pullRequest: PR,
        files: [
            {
                filename: 'src/page.tsx',
                status: 'modified',
                additions: 4,
                deletions: 1,
                patch: '@@ -1 +1 @@\n-old\n+new',
                truncated: false,
            },
        ],
        truncated: false,
        reviews: [],
        ...overrides,
    };
}

const PROPS = { workId: 'work-1', owner: 'octo', repo: 'acme', prNumber: 7 };

/**
 * Wave 7 feature h — the diff + agent-review view. The states worth
 * pinning: truncation must be visible (never a silently partial diff),
 * a `failed` review RESULT must surface its reason rather than reading
 * as success, and the review action must re-fetch so the new review
 * appears.
 */
describe('PullRequestDiffPanel', () => {
    beforeEach(() => {
        diffMock.mockReset();
        reviewMock.mockReset();
    });

    it('renders the per-file diff', () => {
        render(<PullRequestDiffPanel {...PROPS} initialDiff={diffPayload() as never} />);
        expect(screen.getByTestId('pr-diff-panel')).toBeInTheDocument();
        expect(screen.getByTestId('pr-diff-file')).toHaveTextContent('src/page.tsx');
        expect(screen.getByTestId('pr-reviews-empty')).toBeInTheDocument();
        expect(screen.queryByTestId('pr-diff-truncated')).not.toBeInTheDocument();
    });

    it('says so when the API capped the diff', () => {
        render(
            <PullRequestDiffPanel
                {...PROPS}
                initialDiff={
                    diffPayload({
                        truncated: true,
                        files: [
                            {
                                filename: 'huge.lock',
                                status: 'modified',
                                additions: 9999,
                                deletions: 0,
                                patch: 'x',
                                truncated: true,
                            },
                        ],
                    }) as never
                }
            />,
        );
        expect(screen.getByTestId('pr-diff-truncated')).toBeInTheDocument();
        expect(screen.getByTestId('pr-diff-file-truncated')).toBeInTheDocument();
    });

    it('lists recorded agent reviews', () => {
        render(
            <PullRequestDiffPanel
                {...PROPS}
                initialDiff={
                    diffPayload({
                        reviews: [
                            {
                                id: 'e1',
                                occurredAt: '2026-07-25T10:00:00.000Z',
                                summary: 'Looks good, watch the null case.',
                                commentCount: 2,
                                posted: true,
                                sourceUrl: PR.url,
                            },
                        ],
                    }) as never
                }
            />,
        );
        expect(screen.getByTestId('pr-reviews-list')).toBeInTheDocument();
        expect(screen.getByTestId('pr-review-item')).toHaveTextContent(
            'Looks good, watch the null case.',
        );
    });

    it('renders an error state when the diff fetch fails', async () => {
        diffMock.mockResolvedValue({ success: false, error: 'diff too large' });
        render(<PullRequestDiffPanel {...PROPS} />);
        await waitFor(() =>
            expect(screen.getByTestId('pr-diff-error')).toHaveTextContent('diff too large'),
        );
    });

    it('requests an agent review and re-fetches the diff on success', async () => {
        const user = userEvent.setup();
        reviewMock.mockResolvedValue({ success: true, data: { status: 'posted' } });
        diffMock.mockResolvedValue({ success: true, data: diffPayload() });

        render(<PullRequestDiffPanel {...PROPS} initialDiff={diffPayload() as never} />);
        await user.click(screen.getByTestId('pr-request-review'));

        await waitFor(() => expect(reviewMock).toHaveBeenCalledWith(PROPS));
        await waitFor(() => expect(diffMock).toHaveBeenCalledWith(PROPS));
        expect(screen.queryByTestId('pr-review-error')).not.toBeInTheDocument();
    });

    it('surfaces a failed review RESULT rather than reading as success', async () => {
        const user = userEvent.setup();
        reviewMock.mockResolvedValue({
            success: true,
            data: { status: 'failed', error: 'no AI provider enabled' },
        });
        diffMock.mockResolvedValue({ success: true, data: diffPayload() });

        render(<PullRequestDiffPanel {...PROPS} initialDiff={diffPayload() as never} />);
        await user.click(screen.getByTestId('pr-request-review'));

        await waitFor(() =>
            expect(screen.getByTestId('pr-review-error')).toHaveTextContent(
                'no AI provider enabled',
            ),
        );
    });

    it('surfaces a transport-level review failure', async () => {
        const user = userEvent.setup();
        reviewMock.mockResolvedValue({ success: false, error: 'rate limited' });

        render(<PullRequestDiffPanel {...PROPS} initialDiff={diffPayload() as never} />);
        await user.click(screen.getByTestId('pr-request-review'));

        await waitFor(() =>
            expect(screen.getByTestId('pr-review-error')).toHaveTextContent('rate limited'),
        );
    });
});

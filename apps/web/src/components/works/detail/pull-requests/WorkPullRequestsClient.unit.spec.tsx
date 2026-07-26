import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listMock = vi.fn();
const diffMock = vi.fn();
const reviewMock = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
    useLocale: () => 'en',
}));
vi.mock('@/app/actions/works/pull-requests', () => ({
    listWorkPullRequestsAction: (...args: unknown[]) => listMock(...args),
    getWorkPullRequestDiffAction: (...args: unknown[]) => diffMock(...args),
    requestWorkPullRequestReviewAction: (...args: unknown[]) => reviewMock(...args),
    listWorkIngestedEventsAction: vi.fn(),
}));

import { WorkPullRequestsClient } from './WorkPullRequestsClient';

const PR = {
    number: 7,
    title: 'Add the landing page',
    state: 'open' as const,
    head: 'feat/landing',
    base: 'main',
    url: 'https://git.example/octo/acme/pull/7',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    author: { username: 'ada' },
};

const REPO = {
    role: 'work' as const,
    owner: 'octo',
    repo: 'acme',
    pullRequests: [PR],
};

/**
 * Wave 7 feature h — the tab that finally consumes the PR listing
 * endpoint. The load-bearing states are: empty, per-repo degradation,
 * and selecting a PR to open the diff panel.
 */
describe('WorkPullRequestsClient', () => {
    beforeEach(() => {
        listMock.mockReset();
        diffMock.mockReset();
        reviewMock.mockReset();
        diffMock.mockResolvedValue({
            success: true,
            data: {
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
            },
        });
    });

    it('renders the open PRs of each repo with a state pill', () => {
        render(<WorkPullRequestsClient workId="work-1" initialRepos={[REPO]} />);

        expect(screen.getByTestId('pull-requests-shell')).toBeInTheDocument();
        expect(screen.getByTestId('pull-request-row')).toBeInTheDocument();
        expect(screen.getByText(/#7 Add the landing page/)).toBeInTheDocument();
        expect(screen.getByTestId('pr-state-pill-open')).toBeInTheDocument();
        // Externally-sourced PR links never open without noopener.
        const external = screen.getByTestId('pull-request-external-7');
        expect(external).toHaveAttribute('href', PR.url);
        expect(external).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('renders the empty state when no repo has an open PR', () => {
        render(
            <WorkPullRequestsClient
                workId="work-1"
                initialRepos={[{ ...REPO, pullRequests: [] }]}
            />,
        );
        expect(screen.getByTestId('pull-requests-empty')).toBeInTheDocument();
        expect(screen.getByTestId('pull-requests-repo-empty')).toBeInTheDocument();
    });

    it('degrades one failing repo to an inline warning without hiding the others', () => {
        render(
            <WorkPullRequestsClient
                workId="work-1"
                initialRepos={[
                    REPO,
                    {
                        role: 'website',
                        owner: 'octo',
                        repo: 'acme-website',
                        pullRequests: [],
                        error: 'repo not generated yet',
                    },
                ]}
            />,
        );
        expect(screen.getByTestId('pull-requests-repo-error')).toHaveTextContent(
            'repo not generated yet',
        );
        expect(screen.getByTestId('pull-request-row')).toBeInTheDocument();
    });

    it('surfaces a load error instead of an empty list', () => {
        render(
            <WorkPullRequestsClient
                workId="work-1"
                initialRepos={[]}
                initialError="git not connected"
            />,
        );
        expect(screen.getByTestId('pull-requests-error')).toHaveTextContent('git not connected');
    });

    it('opens the diff panel for the selected PR and closes it again', async () => {
        const user = userEvent.setup();
        render(<WorkPullRequestsClient workId="work-1" initialRepos={[REPO]} />);

        await user.click(screen.getByTestId('pull-request-open-7'));
        await waitFor(() => expect(screen.getByTestId('pr-diff-panel')).toBeInTheDocument());
        expect(diffMock).toHaveBeenCalledWith({
            workId: 'work-1',
            owner: 'octo',
            repo: 'acme',
            prNumber: 7,
        });

        await user.click(screen.getByTestId('pull-request-open-7'));
        await waitFor(() => expect(screen.queryByTestId('pr-diff-panel')).not.toBeInTheDocument());
    });
});

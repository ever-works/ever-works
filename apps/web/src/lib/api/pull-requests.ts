import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Wave 7 feature h — server-only client for the in-platform PR review
 * surface (`apps/api/src/works/work-pull-requests.controller.ts`).
 *
 * Every endpoint here is owner-scoped server-side AND restricted to the
 * Work's own declared repositories, so the web tier never has to decide
 * which repos a caller may read.
 */

export type WorkRepoRole = 'work' | 'website' | 'data';

export interface PullRequestAuthorView {
    username: string;
    type?: string;
    orgVerified?: boolean;
}

export interface PullRequestView {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    head: string;
    base: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    body?: string;
    author?: PullRequestAuthorView;
}

export interface WorkRepoPullRequestsView {
    role: WorkRepoRole;
    owner: string;
    repo: string;
    pullRequests: PullRequestView[];
    /** Present when this repo's listing failed (others still return). */
    error?: string;
}

export interface PullRequestDiffFileView {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    /** True when this file's patch was cut at the byte cap. */
    truncated: boolean;
}

/** One agent review of this PR, recorded on the event-ingest spine. */
export interface PullRequestReviewView {
    id: string;
    occurredAt: string;
    summary: string | null;
    commentCount: number | null;
    posted: boolean;
    sourceUrl: string | null;
}

export interface PullRequestDiffView {
    pullRequest: PullRequestView;
    files: PullRequestDiffFileView[];
    /** True when the file list or a patch was cut by the byte budget. */
    truncated: boolean;
    reviews: PullRequestReviewView[];
}

/** Result of an on-demand agent review run (mirrors `PrReviewResult`). */
export interface PullRequestReviewResult {
    status: 'posted' | 'failed';
    owner: string;
    repo: string;
    prNumber: number;
    workId?: string;
    summary: string;
    comments: Array<{ path: string; comment: string }>;
    commentId?: number;
    prUrl?: string;
    context: { work: boolean; kb: boolean; memory: boolean };
    error?: string;
}

// NOTE: no leading `/api` here — `serverFetch`/`serverMutation` prepend
// `API_URL`, which `lib/constants.ts` normalises to already end in
// `/api`. Matches every other helper in this folder.
export const pullRequestsAPI = {
    /** `GET /api/works/:id/pull-requests` */
    list: async (workId: string) => {
        return serverFetch<{ repos: WorkRepoPullRequestsView[] }>(`/works/${workId}/pull-requests`);
    },

    /** `GET /api/works/:id/pull-requests/:owner/:repo/:number` */
    getDiff: async (workId: string, owner: string, repo: string, prNumber: number) => {
        return serverFetch<PullRequestDiffView>(
            `/works/${workId}/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(
                repo,
            )}/${prNumber}`,
        );
    },

    /** `POST /api/works/:id/pull-requests/:owner/:repo/:number/review` */
    requestReview: async (workId: string, owner: string, repo: string, prNumber: number) => {
        return serverMutation<PullRequestReviewResult>({
            endpoint: `/works/${workId}/pull-requests/${encodeURIComponent(
                owner,
            )}/${encodeURIComponent(repo)}/${prNumber}/review`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};

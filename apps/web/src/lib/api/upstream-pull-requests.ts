import 'server-only';
import type {
    UpstreamEligibilityView,
    UpstreamPullRequestDetailView,
    UpstreamPullRequestListResponse,
    UpstreamPullRequestState,
} from '@ever-works/contracts';
import { serverFetch } from './server-api';

/** `GET …/eligibility` — the view plus the active record the `409` path names (FR-5). */
export type UpstreamEligibilityAnswer = UpstreamEligibilityView & {
    activeProposalId?: string | null;
};

/**
 * APW-09 — server-only client for `/api/works/:id/upstream-pull-requests[...]` (T10/T11).
 * No leading `/api`: `serverFetch` prepends `API_URL`, which already ends in `/api`.
 */
export const upstreamPullRequestsAPI = {
    /** Every member's upstream pull request records for the App Work, newest first. */
    list: async (
        workId: string,
        query: { state?: UpstreamPullRequestState; limit?: number } = {},
    ): Promise<UpstreamPullRequestListResponse> => {
        const params = new URLSearchParams();
        if (query.state) params.set('state', query.state);
        if (query.limit) params.set('limit', String(query.limit));
        const suffix = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<UpstreamPullRequestListResponse>(
            `/works/${encodeURIComponent(workId)}/upstream-pull-requests${suffix}`,
        );
    },

    /** Whether the caller may propose `taskId` upstream (needs edit access; `404` otherwise). */
    eligibility: async (
        workId: string,
        taskId?: string | null,
    ): Promise<UpstreamEligibilityAnswer> => {
        const suffix = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
        return serverFetch<UpstreamEligibilityAnswer>(
            `/works/${encodeURIComponent(workId)}/upstream-pull-requests/eligibility${suffix}`,
        );
    },

    /** One record of the App Work. */
    get: async (workId: string, prId: string): Promise<UpstreamPullRequestDetailView> => {
        return serverFetch<UpstreamPullRequestDetailView>(
            `/works/${encodeURIComponent(workId)}/upstream-pull-requests/${encodeURIComponent(prId)}`,
        );
    },
};

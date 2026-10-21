import 'server-only';
import type {
    FleetCheckoutChangesReply,
    FleetCheckoutPullRequestFacts,
    FleetSessionBranchProposal,
} from '@ever-works/contracts';
import { serverFetch } from './server-api';

// NOTE: no leading `/api` here — `serverFetch`/`serverMutation` prepend
// `API_URL`, which already ends in `/api` (see `lib/api/fleet.ts`).
const BASE = '/fleet';

function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue;
        search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

/** The branch proposal's query (FL-06 plan §5). */
export interface FleetBranchProposalQuery {
    nodeId: string;
    checkoutId: string;
    agentId?: string;
    firstMessage?: string;
    title?: string;
    taskId?: string;
}

/**
 * Session git & actions (FL-06, CONTRACTS §11.2) — the server-side client of
 * the session git routes. Every refusal arrives as an `ApiResponseError`
 * whose `code` is the CONTRACTS §8 code and whose `details.error.hint` is the
 * sentence to show.
 */
export const fleetSessionGitAPI = {
    branchProposal: async (input: FleetBranchProposalQuery) => {
        return serverFetch<FleetSessionBranchProposal>(
            `${BASE}/sessions/branch-proposal${query({
                nodeId: input.nodeId,
                checkoutId: input.checkoutId,
                agentId: input.agentId,
                // The slug reads the opening words only; the query stays short.
                firstMessage: input.firstMessage?.slice(0, 400),
                title: input.title?.slice(0, 200),
                taskId: input.taskId,
            })}`,
        );
    },

    changes: async (checkoutId: string, maxBytes?: number) => {
        return serverFetch<FleetCheckoutChangesReply>(
            `${BASE}/checkouts/${encodeURIComponent(checkoutId)}/changes${query({ maxBytes })}`,
        );
    },

    pullRequest: async (checkoutId: string) => {
        return serverFetch<FleetCheckoutPullRequestFacts>(
            `${BASE}/checkouts/${encodeURIComponent(checkoutId)}/pull-request`,
        );
    },
};

import 'server-only';
import type { WorkCostRollup } from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * APW-08 — the App Work change request (`POST /api/works/:id/evolve`) and the Work cost rollup
 * (`GET /api/works/:id/cost`), as the App Work overview's dialog and summary read them.
 */

/** What `POST evolve` answers when the change was filed (202). */
export interface AppChangeRequestAnswer {
    status: 'accepted';
    taskId: string;
    taskSlug: string;
    taskUrl: string;
    runId: string | null;
    agentId: string;
    dispatched: boolean;
    parked: boolean;
    /** Filed but held for the Work's owner (a member's request, never started). */
    awaitingOwner?: boolean;
    warnings: string[];
}

const base = (workId: string) => `/works/${encodeURIComponent(workId)}`;

export const appChangesAPI = {
    request: async (workId: string, body: { request: string }): Promise<AppChangeRequestAnswer> =>
        serverMutation<AppChangeRequestAnswer>({
            endpoint: `${base(workId)}/evolve`,
            // `channel` is one of the DTO's own values (`chat` | `card` | `api`): this is the card.
            data: { request: body.request, channel: 'card' },
            method: 'POST',
            wrapInData: false,
        }),

    cost: async (workId: string): Promise<WorkCostRollup> =>
        serverFetch<WorkCostRollup>(`${base(workId)}/cost`),
};

import 'server-only';
import type { FleetSessionBoardResponse, FleetSessionListResponse, FleetSessionView } from '@ever-works/contracts';
import { serverFetch } from './server-api';

/**
 * Sessions on computers (FL-04 P1b) — the reads the session page and the
 * computer page's Sessions tab server-render with (`api/fleet/sessions…`, see
 * `apps/api/src/fleet/sessions/fleet-sessions.controller.ts`).
 *
 * Only first-paint reads live here. Everything that changes a session (start,
 * rename, end, restart) and the attach token go through the BFF routes under
 * `app/api/fleet/`, so a token is minted server-side and never round-trips
 * through client code.
 */
export const fleetSessionsAPI = {
    /** One session, with its last screen when ended and who is attached when live. */
    get: async (sessionId: string): Promise<FleetSessionView> =>
        serverFetch<FleetSessionView>(`/fleet/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'GET',
        }),

    /** One computer's sessions, most recently active first, and its recent folders. */
    listForNode: async (
        nodeId: string,
        query: { state?: 'live' | 'ended'; limit?: number } = {},
    ): Promise<FleetSessionListResponse> => {
        const params = new URLSearchParams();
        if (query.state) params.set('state', query.state);
        if (query.limit) params.set('limit', String(query.limit));
        const suffix = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<FleetSessionListResponse>(
            `/fleet/nodes/${encodeURIComponent(nodeId)}/sessions${suffix}`,
            { method: 'GET' },
        );
    },

    /** FL-05 P3: the Sessions board's first paint (four columns of live sessions). */
    board: async (query: { nodeId?: string; agentId?: string; kind?: 'owner' | 'agent' } = {}): Promise<FleetSessionBoardResponse> => {
        const params = new URLSearchParams({ view: 'board' });
        if (query.nodeId) params.set('nodeId', query.nodeId);
        if (query.agentId) params.set('agentId', query.agentId);
        if (query.kind) params.set('kind', query.kind);
        return serverFetch<FleetSessionBoardResponse>(`/fleet/sessions?${params.toString()}`, { method: 'GET' });
    },

    /** FL-05 P3: the Sessions list's first paint (live and ended, most recently active first). */
    list: async (query: { nodeId?: string; agentId?: string; kind?: 'owner' | 'agent'; limit?: number } = {}): Promise<FleetSessionListResponse> => {
        const params = new URLSearchParams({ limit: String(query.limit ?? 200) });
        if (query.nodeId) params.set('nodeId', query.nodeId);
        if (query.agentId) params.set('agentId', query.agentId);
        if (query.kind) params.set('kind', query.kind);
        return serverFetch<FleetSessionListResponse>(`/fleet/sessions?${params.toString()}`, { method: 'GET' });
    },

    /** Sessions of one Agent across every computer the person may see (the Agent page block, P2). */
    listForAgent: async (agentId: string, limit = 20): Promise<FleetSessionListResponse> =>
        serverFetch<FleetSessionListResponse>(
            `/fleet/sessions?agentId=${encodeURIComponent(agentId)}&limit=${limit}`,
            { method: 'GET' },
        ),
};

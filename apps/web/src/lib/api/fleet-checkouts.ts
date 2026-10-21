import 'server-only';
import type {
    FleetCheckoutListResponse,
    FleetCheckoutOperationResponse,
    FleetCheckoutState,
    FleetCheckoutSyncOp,
    FleetCheckoutView,
    FleetNodeCheckoutsResponse,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

// NOTE: no leading `/api` here — `serverFetch`/`serverMutation` prepend
// `API_URL`, which already ends in `/api` (see `lib/api/fleet.ts`).
const BASE = '/fleet';

function query(params: Record<string, string | number | boolean | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === false) continue;
        search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

/**
 * Checkouts on computers (FL-14, CONTRACTS §11.2) — the server-side client of
 * `/api/fleet/checkouts*`. Every refusal arrives as an `ApiResponseError`
 * whose `code` is the CONTRACTS §8 code and whose `details.error.hint` is the
 * sentence to show.
 */
export const fleetCheckoutsAPI = {
    list: async (
        options: { nodeId?: string; workId?: string; state?: FleetCheckoutState; cursor?: string } = {},
    ) => {
        return serverFetch<FleetCheckoutListResponse>(
            `${BASE}/checkouts${query({
                nodeId: options.nodeId,
                workId: options.workId,
                state: options.state,
                cursor: options.cursor,
            })}`,
        );
    },

    listForNode: async (
        nodeId: string,
        options: { rescan?: boolean; refresh?: boolean; state?: FleetCheckoutState } = {},
    ) => {
        return serverFetch<FleetNodeCheckoutsResponse>(
            `${BASE}/nodes/${encodeURIComponent(nodeId)}/checkouts${query({
                rescan: options.rescan,
                refresh: options.refresh,
                state: options.state,
            })}`,
        );
    },

    get: async (id: string) => {
        return serverFetch<FleetCheckoutView>(`${BASE}/checkouts/${encodeURIComponent(id)}`);
    },

    refresh: async (id: string) => {
        return serverMutation<FleetCheckoutOperationResponse>({
            endpoint: `${BASE}/checkouts/${encodeURIComponent(id)}/refresh`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    sync: async (id: string, op: FleetCheckoutSyncOp, confirm?: boolean) => {
        return serverMutation<FleetCheckoutOperationResponse>({
            endpoint: `${BASE}/checkouts/${encodeURIComponent(id)}/sync`,
            data: confirm === undefined ? { op } : { op, confirm },
            method: 'POST',
            wrapInData: false,
        });
    },

    archive: async (id: string, confirm: boolean) => {
        return serverMutation<FleetCheckoutView>({
            endpoint: `${BASE}/checkouts/${encodeURIComponent(id)}/archive`,
            data: { confirm },
            method: 'POST',
            wrapInData: false,
        });
    },

    restore: async (id: string) => {
        return serverMutation<FleetCheckoutView>({
            endpoint: `${BASE}/checkouts/${encodeURIComponent(id)}/restore`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};

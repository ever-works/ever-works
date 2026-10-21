import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, forwardFleetCall, invalidIdResponse, isUuid, readJsonBody } from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Schedules on computers (FL-13 P2) — the Agents an Agent-session schedule on this computer may use. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/schedules/agents`), { method: 'GET', headers });
});

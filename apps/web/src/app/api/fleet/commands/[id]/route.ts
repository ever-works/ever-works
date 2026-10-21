import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, forwardFleetCall, invalidIdResponse, isUuid } from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Commands on computers (FL-12) — `GET /api/fleet/commands/:id`: one of the
 * person's Commands with every computer's run. Polled once a second while a
 * run is live (lane-log decision 1).
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/commands/${id}`), { method: 'GET', headers });
});

import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, forwardFleetCall, invalidIdResponse, isUuid } from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Desktop view & control (FL-07) — the displays this computer last reported. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/displays`), { method: 'GET', headers });
});

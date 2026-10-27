import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Desktop view & control (FL-07) — may this computer's desktop be watched now, and if not why. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/availability`), {
        method: 'GET',
        headers,
    });
});

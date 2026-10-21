import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Files on computers (FL-11, FR-14, FR-20) — my transfers on this computer and today's bytes. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/transfers`), {
        method: 'GET',
        headers,
    });
});

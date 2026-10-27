import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Schedules on computers (FL-13 P2, FR-22) — Pause all on this computer (`confirm` after the count). */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/schedules/pause-all`), {
        method: 'POST',
        headers,
        body: raw.confirm === true ? { confirm: true } : {},
    });
});

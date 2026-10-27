import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Schedules on computers (FL-13 P2, FR-22) — Undo a Pause all within 15 minutes. */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    const breakerAt =
        typeof raw.breakerAt === 'string' && raw.breakerAt.length <= 40 ? raw.breakerAt : '';
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/schedules/resume-all`), {
        method: 'POST',
        headers,
        body: { breakerAt },
    });
});

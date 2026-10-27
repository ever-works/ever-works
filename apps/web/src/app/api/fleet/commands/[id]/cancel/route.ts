import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Commands on computers (FL-12) — `POST /api/fleet/commands/:id/cancel`: stop
 * a running Command on every computer it still runs on. No body.
 */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/commands/${id}/cancel`), { method: 'POST', headers });
});

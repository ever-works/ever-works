import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Commands on computers (FL-12 P2, spec §5.3) — `GET
 * /api/fleet/nodes/:id/commands/last`: the latest run of the person's own
 * Commands on one computer, for its Overview ("Last command"), or
 * `{ last: null }`.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/commands/last`), { method: 'GET', headers });
});

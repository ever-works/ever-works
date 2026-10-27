import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    sanitizeRunsQuery,
} from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * `GET /api/fleet/commands/:id/runs` — a Command's runs; for a schedule
 * (FL-13, FR-20) its last 30, newest first, with the fire each belongs to.
 */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const query = sanitizeRunsQuery(new URL(request.url).searchParams);
    return forwardFleetCall(fleetApiUrl(`/commands/${id}/runs${query}`), {
        method: 'GET',
        headers,
    });
});

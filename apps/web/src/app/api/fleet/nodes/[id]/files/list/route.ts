import { bffProxy } from '@/lib/api/bff-proxy';
import {
    filesUpstreamQuery,
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    invalidLocationResponse,
    isUuid,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Files on computers (FL-11) — one folder's entries (`?root&path&hidden`). */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const query = filesUpstreamQuery(new URL(request.url).searchParams, { single: ['hidden'] });
    if (query === null) return invalidLocationResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/list${query}`), {
        method: 'GET',
        headers,
    });
});

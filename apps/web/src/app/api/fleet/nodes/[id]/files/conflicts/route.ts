import { bffProxy } from '@/lib/api/bff-proxy';
import {
    filesLocation,
    filesNames,
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    invalidLocationResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Files on computers (FL-11, FR-12) — the same-name entries an upload would meet. Nothing is written. */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    const location = filesLocation(raw);
    const names = filesNames(raw.names);
    if (!location || !names) return invalidLocationResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/conflicts`), {
        method: 'POST',
        headers,
        body: { root: location.root, path: location.path, names },
    });
});

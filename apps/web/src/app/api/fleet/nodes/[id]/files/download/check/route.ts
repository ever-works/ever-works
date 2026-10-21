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

/**
 * Files on computers (FL-11, FR-16, FR-17) — what a download would move, asked
 * before the browser starts it: counts against the limits and the
 * credential-shaped files inside (the dialog shows first). Nothing is sent.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    const location = filesLocation(raw);
    const entries = filesNames(raw.entries);
    if (!location || !entries) return invalidLocationResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/download/check`), {
        method: 'POST',
        headers,
        body: { root: location.root, path: location.path, entries },
    });
});

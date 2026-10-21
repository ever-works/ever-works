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
 * Files on computers (FL-11, FR-18) — delete entries of a folder. Class
 * `confirm-destructive`: without `confirmName` (or with the wrong one) the
 * platform answers 409 `confirmation_required`, passed through for the dialog.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    const location = filesLocation(raw);
    const entries = filesNames(raw.entries);
    if (!location || !entries) return invalidLocationResponse();
    const body: Record<string, unknown> = { root: location.root, path: location.path, entries };
    if (typeof raw.confirmName === 'string' && raw.confirmName.length <= 255)
        body.confirmName = raw.confirmName;
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/delete`), {
        method: 'POST',
        headers,
        body,
    });
});

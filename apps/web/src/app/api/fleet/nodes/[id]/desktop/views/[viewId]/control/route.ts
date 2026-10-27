import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardControlCall,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeDesktopControlBody,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string }> };

/** Desktop view & control (FL-07 P2) — control of the computer as my view sees it. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}/control`), {
        method: 'GET',
        headers,
    });
});

/** Take control (`confirm: true`) and receive the driver grant, or ask for it (`request: true`). */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    const body = sanitizeDesktopControlBody(await readJsonBody(request));
    return forwardControlCall(fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}/control`), {
        method: 'POST',
        headers,
        body,
    });
});

/** Give control back; answers the viewer grant to re-attach with. */
export const DELETE = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardControlCall(fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}/control`), {
        method: 'DELETE',
        headers,
    });
});

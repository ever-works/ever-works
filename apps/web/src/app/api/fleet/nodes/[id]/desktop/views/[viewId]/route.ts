import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    forwardGrantCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeDesktopViewBody,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string }> };

/** Desktop view & control (FL-07) — one of my desktop views. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}`), { method: 'GET', headers });
});

/** Another display (audited) or quality — answers a fresh grant to re-attach with. */
export const PATCH = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    const body = sanitizeDesktopViewBody(await readJsonBody(request));
    return forwardGrantCall(
        fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}`),
        { method: 'PATCH', headers, body },
        'open',
    );
});

/** End the view (idempotent). */
export const DELETE = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}`), { method: 'DELETE', headers });
});

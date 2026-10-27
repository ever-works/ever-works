import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardControlCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string }> };

/** Desktop view & control (FL-07 P2) — extend control from the view holding it. */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardControlCall(fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}/control/extend`), {
        method: 'POST',
        headers,
    });
});

import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardGrantCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string }> };

/** Desktop view & control (FL-07) — a fresh single-use viewer token for the same view (a reconnect). */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardGrantCall(
        fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}/attach-token`),
        { method: 'POST', headers },
        'grant',
    );
});

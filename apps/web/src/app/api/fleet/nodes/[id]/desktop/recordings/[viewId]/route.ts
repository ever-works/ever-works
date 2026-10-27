import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string }> };

/** Desktop view & control (FL-07 P2.C) — one recording with its chunks and control spans. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/recordings/${viewId}`), {
        method: 'GET',
        headers,
    });
});

/** "Delete now": the body is rebuilt — `confirm: true` or nothing (CONTRACTS §2.2). */
export const DELETE = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/recordings/${viewId}`), {
        method: 'DELETE',
        headers,
        body: raw.confirm === true ? { confirm: true } : {},
    });
});

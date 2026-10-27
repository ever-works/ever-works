import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardGrantCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeDesktopViewBody,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Desktop view & control (FL-07) — open a live view of this computer's
 * desktop (watching only). The answer's grant carries the single-use viewer
 * token and a browser-reachable socket URL; a refusal passes through with its
 * status and hint.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeDesktopViewBody(await readJsonBody(request));
    return forwardGrantCall(
        fleetApiUrl(`/nodes/${id}/desktop/views`),
        { method: 'POST', headers, body },
        'open',
    );
});

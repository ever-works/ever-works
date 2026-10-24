import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizePatchBody,
} from '@/lib/api/fleet-sessions-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Sessions on computers (FL-04 P1b) — one session: `GET` (with its last
 * screen when ended, and who is attached when live) and `PATCH` (rename,
 * 1–200 characters; or, FL-05, `{ acknowledge: <attention key> }` — opening
 * the session clears its unread mark). A session on a computer the person may
 * not see answers the platform's 404, passed through.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}`), { method: 'GET', headers });
});

export const PATCH = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizePatchBody(await readJsonBody(request));
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}`), { method: 'PATCH', headers, body });
});

import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeEndBody,
} from '@/lib/api/fleet-sessions-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Sessions on computers (FL-04 P1b) — `POST /api/fleet/sessions/:id/end`.
 * Only `confirm: true` is forwarded: without it the platform answers
 * `confirmation_required` with the sentence the dialog shows (CONTRACTS §2.2).
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeEndBody(await readJsonBody(request));
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}/end`), { method: 'POST', headers, body });
});

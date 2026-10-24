import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeRestartBody,
} from '@/lib/api/fleet-sessions-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Sessions on computers (FL-04 P1b) — `POST /api/fleet/sessions/:id/restart`:
 * a new session with the ended one's kind, CLI, folder and title. Only a
 * terminal size is forwarded.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeRestartBody(await readJsonBody(request));
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}/restart`), {
        method: 'POST',
        headers,
        body,
    });
});

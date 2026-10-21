import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeListQuery,
    sanitizeStartBody,
} from '@/lib/api/fleet-sessions-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Sessions on computers (FL-04 P1b) — one computer's sessions: `GET` (a page,
 * most recently active first, with the start dialog's recent folders) and
 * `POST` (start one). The start body is rebuilt from its allow-list; every
 * refusal (`consent_missing` with the command, `limit_exceeded` with the
 * eight sessions, `unsupported_on_node`, `invalid` naming the field) passes
 * through with its status.
 */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const query = sanitizeListQuery(new URL(request.url).searchParams);
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/sessions${query}`), {
        method: 'GET',
        headers,
    });
});

export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeStartBody(await readJsonBody(request));
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/sessions`), {
        method: 'POST',
        headers,
        body: body as Record<string, unknown>,
    });
});

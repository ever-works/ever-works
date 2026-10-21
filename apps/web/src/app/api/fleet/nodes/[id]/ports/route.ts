import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    sanitizePortsQuery,
} from '@/lib/api/fleet-ports-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Servers and ports (FL-10) — what one computer is listening on (`GET`), with
 * the watched ports of "Open a port…" (`?watch=`). Every refusal
 * (`consent_missing` with the command, `unsupported_on_node`, `kill_switch`,
 * `unreachable`) passes through with its status.
 */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const query = sanitizePortsQuery(new URL(request.url).searchParams);
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/ports${query}`), { method: 'GET', headers });
});

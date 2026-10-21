import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    parsePortSegment,
} from '@/lib/api/fleet-ports-bff';

type RouteContext = { params: Promise<{ id: string; port: string }> };

/**
 * Servers and ports, phase 2 (FL-10) — **Preview in my browser**: open
 * (`POST`), read (`GET`, with a fresh one-time address) and close (`DELETE`)
 * the person's preview tunnel to one port. No body travels upstream; every
 * refusal (`limit_exceeded` listing the four open previews, `kill_switch`,
 * `not_found` with the flag off) passes through with its status. The answer's
 * `openUrl` carries a 60-second, single-use hand-off — JSON only, never put in
 * a URL this tier serves.
 */
async function forward(
    method: 'GET' | 'POST' | 'DELETE',
    headers: Headers,
    ctx: RouteContext,
): Promise<Response> {
    const { id, port: segment } = await ctx.params;
    const port = parsePortSegment(segment);
    if (!isUuid(id) || port === null) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/ports/${port}/preview`), { method, headers });
}

export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => forward('GET', headers, ctx));
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => forward('POST', headers, ctx));
export const DELETE = bffProxy<RouteContext>(async ({ headers }, ctx) => forward('DELETE', headers, ctx));

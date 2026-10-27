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
 * Servers and ports, phase 3 (FL-10, FR-33) — a server this tab was watching
 * stopped: ask the platform to file the Inbox item. No body; the platform
 * checks the person may see the computer and files at most one item per port
 * per five minutes.
 */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, port: segment } = await ctx.params;
    const port = parsePortSegment(segment);
    if (!isUuid(id) || port === null) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/ports/${port}/watch-stopped`), {
        method: 'POST',
        headers,
    });
});

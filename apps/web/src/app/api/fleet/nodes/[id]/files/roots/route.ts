import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Files on computers (FL-11) — one computer's allowed roots (its checkouts,
 * the workspace root, `--files-root` folders), read over its node link. Every
 * refusal passes through with its status.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/roots`), { method: 'GET', headers });
});

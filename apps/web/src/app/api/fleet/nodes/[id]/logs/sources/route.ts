import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, forwardFleetCall, invalidIdResponse, isUuid } from '@/lib/api/fleet-logs-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Logs on computers (FL-08) — one computer's log sources (System, Files,
 * Containers, Services), read over its node link. Every refusal
 * (`consent_missing` with the command, `permission_denied`, `kill_switch`,
 * `unreachable` with when it was last seen) passes through with its status.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/logs/sources`), { method: 'GET', headers });
});

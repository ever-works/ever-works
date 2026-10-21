import { bffProxy } from '@/lib/api/bff-proxy';
import { API_URL } from '@/lib/constants';
import { forwardFleetCall, invalidIdResponse, isUuid } from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Schedules on computers (FL-13, plan §5) — `GET /api/fleet/nodes/:id/schedules`:
 * the computer tab's list. There is no platform route of that name (the plan
 * keeps ONE list for every source): this reads the Schedules view's page
 * filtered to `node_schedule` rows on this computer, whose rows carry the
 * full `nodeSchedule` facts.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const query = new URLSearchParams({ sourceType: 'node_schedule', node: id, limit: '50' });
    return forwardFleetCall(`${API_URL}/schedules/page?${query.toString()}`, { method: 'GET', headers });
});

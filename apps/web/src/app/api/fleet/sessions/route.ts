import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, forwardFleetCall, sanitizeListQuery } from '@/lib/api/fleet-sessions-bff';

/**
 * Sessions on computers (FL-04 P1b) — `GET /api/fleet/sessions`: sessions on
 * every computer the signed-in person may see sessions on, one page at a time.
 * The query is rebuilt from its allow-list; the platform's status and body
 * pass through.
 */
export const GET = bffProxy(async ({ request, headers }) => {
    const query = sanitizeListQuery(new URL(request.url).searchParams);
    return forwardFleetCall(fleetApiUrl(`/sessions${query}`), { method: 'GET', headers });
});

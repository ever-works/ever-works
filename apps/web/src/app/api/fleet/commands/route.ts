import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    readJsonBody,
    sanitizeCommandListQuery,
    sanitizeRunBody,
} from '@/lib/api/fleet-commands-bff';

/**
 * Commands on computers (FL-12) — `GET /api/fleet/commands`: the signed-in
 * person's recent one-off Commands with their runs (Recent, the last 8).
 */
export const GET = bffProxy(async ({ request, headers }) => {
    const query = sanitizeCommandListQuery(new URL(request.url).searchParams);
    return forwardFleetCall(fleetApiUrl(`/commands${query}`), { method: 'GET', headers });
});

/**
 * `POST /api/fleet/commands`: run a command on computers. The body is rebuilt
 * from its allow-list; without `confirm: true` the platform answers 409
 * `confirmation_required` with one summary line per computer, which the
 * dialog renders before it repeats the call with `confirm: true`.
 */
export const POST = bffProxy(async ({ request, headers }) => {
    const body = sanitizeRunBody(await readJsonBody(request));
    return forwardFleetCall(fleetApiUrl('/commands'), {
        method: 'POST',
        headers,
        body: body as Record<string, unknown>,
    });
});

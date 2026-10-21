import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeScheduleUpdateBody,
} from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Commands on computers (FL-12) — `GET /api/fleet/commands/:id`: one of the
 * person's Commands with every computer's run. Polled once a second while a
 * run is live (lane-log decision 1).
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardFleetCall(fleetApiUrl(`/commands/${id}`), { method: 'GET', headers });
});

/**
 * Schedules on computers (FL-13) — `PATCH /api/fleet/commands/:id`: edit one
 * of the person's Command schedules (or move it with `nodeId`). The body is
 * rebuilt from its allow-list; a move or a change of what runs answers 409
 * `confirmation_required` until it carries `confirm: true`.
 */
export const PATCH = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeScheduleUpdateBody(await readJsonBody(request));
    return forwardFleetCall(fleetApiUrl(`/commands/${id}`), {
        method: 'PATCH',
        headers,
        body: body as Record<string, unknown>,
    });
});

/** `DELETE /api/fleet/commands/:id` (FL-13): delete a schedule; `{ confirm: true }` after the summary. */
export const DELETE = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    return forwardFleetCall(fleetApiUrl(`/commands/${id}`), {
        method: 'DELETE',
        headers,
        body: raw.confirm === true ? { confirm: true } : {},
    });
});

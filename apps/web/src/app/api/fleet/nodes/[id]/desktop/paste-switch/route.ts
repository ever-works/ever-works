import { isFleetClipViewId } from '@ever-works/contracts';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/** Paste into a desktop (FL-11 P2, spec §5.8) — whether paste is on for one live view. */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const search = new URL(request.url).searchParams;
    const viewId = search.get('viewId');
    const agentId = search.get('agentId');
    if (!isFleetClipViewId(viewId) || !isUuid(agentId)) return invalidIdResponse();
    const query = new URLSearchParams({ viewId, agentId }).toString();
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/paste-switch?${query}`), {
        method: 'GET',
        headers,
    });
});

/** "Allow paste into this desktop" — off by default; gone when the view ends. */
export const PUT = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    if (
        !isFleetClipViewId(raw.viewId) ||
        !isUuid(raw.agentId) ||
        typeof raw.allowed !== 'boolean'
    ) {
        return invalidIdResponse();
    }
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    const upstream = await fetch(fleetApiUrl(`/nodes/${id}/desktop/paste-switch`), {
        method: 'PUT',
        headers,
        cache: 'no-store',
        body: JSON.stringify({ viewId: raw.viewId, agentId: raw.agentId, allowed: raw.allowed }),
    });
    const text = await upstream.text().catch(() => '');
    return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
});

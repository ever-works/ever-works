import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeRecordingBody,
} from '@/lib/api/fleet-sessions-bff';
import { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Sessions on computers (FL-04 P3) — a session's recording: `GET` the
 * manifest, or with `?from=<seq>&limit=<n>` one page of chunks; `POST
 * { on }` starts or stops recording a live session. The query and the body
 * are rebuilt from their allow-lists; the platform's status passes through.
 */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const params = new URL(request.url).searchParams;
    const out = new URLSearchParams();
    const from = Number(params.get('from'));
    if (params.has('from') && Number.isInteger(from) && from >= 0) out.set('from', String(from));
    const limit = Number(params.get('limit'));
    if (params.has('limit') && Number.isInteger(limit) && limit >= 1 && limit <= 500)
        out.set('limit', String(limit));
    const query = out.toString();
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}/recording${query ? `?${query}` : ''}`), {
        method: 'GET',
        headers,
    });
});

export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeRecordingBody(await readJsonBody(request));
    if (!body) {
        return NextResponse.json(
            { error: { code: 'invalid', hint: 'on must be true or false' } },
            { status: 400 },
        );
    }
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}/recording`), {
        method: 'POST',
        headers,
        body,
    });
});

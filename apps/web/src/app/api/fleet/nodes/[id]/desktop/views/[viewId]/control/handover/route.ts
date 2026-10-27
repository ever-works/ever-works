import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardControlCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeDesktopAnswerBody,
} from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string }> };

/** Desktop view & control (FL-07 P2) — the view holding control answers a request: hand over, or keep. */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, viewId } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId)) return invalidIdResponse();
    const body = sanitizeDesktopAnswerBody(await readJsonBody(request));
    if (!body) {
        return NextResponse.json(
            {
                error: {
                    code: 'invalid',
                    hint: 'a request id and a decision (hand-over or keep)',
                    details: {},
                },
            },
            { status: 400 },
        );
    }
    return forwardControlCall(
        fleetApiUrl(`/nodes/${id}/desktop/views/${viewId}/control/handover`),
        {
            method: 'POST',
            headers,
            body,
        },
    );
});

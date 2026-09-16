import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeHandoverBody,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

/**
 * Agent computers — the view holding control answers a request for it:
 * `{ requestId, decision: 'hand-over' | 'keep' }`, rebuilt from that
 * allow-list before it leaves the web tier.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, sessionId } = await ctx.params;
    if (!isUuid(id) || !isUuid(sessionId)) return invalidIdResponse();
    const body = sanitizeHandoverBody(await readJsonBody(request));
    if (!body) {
        return NextResponse.json({ error: 'Invalid answer' }, { status: 400 });
    }
    return forwardComputerCall(computerApiUrl(id, `/sessions/${sessionId}/control/handover`), {
        method: 'POST',
        headers,
        body,
    });
});

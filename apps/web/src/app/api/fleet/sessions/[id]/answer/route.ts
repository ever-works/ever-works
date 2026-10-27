import { NextResponse } from 'next/server';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeAnswerBody,
} from '@/lib/api/fleet-sessions-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Session attention (FL-05 P2) — `POST /api/fleet/sessions/:id/answer`: the
 * attention key and exactly one of an option id or a free text, rebuilt from
 * an allow-list. The platform's refusals (`invalid` "Already answered",
 * `unreachable`, `kill_switch`, `permission_denied`) pass through in the
 * CONTRACTS §8 envelope so the card can say which.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeAnswerBody(await readJsonBody(request));
    if (!body) {
        return NextResponse.json(
            { error: { code: 'invalid', hint: 'an answer is the key and one option or a text' } },
            { status: 400 },
        );
    }
    return forwardFleetCall(fleetApiUrl(`/sessions/${id}/answer`), {
        method: 'POST',
        headers,
        body,
    });
});

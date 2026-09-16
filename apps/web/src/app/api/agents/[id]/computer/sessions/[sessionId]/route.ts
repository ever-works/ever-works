import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeUpdateBody,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

async function ids(ctx: RouteContext): Promise<{ id: string; sessionId: string } | null> {
    const { id, sessionId } = await ctx.params;
    return isUuid(id) && isUuid(sessionId) ? { id, sessionId } : null;
}

/** One live view: the persisted session plus the relay's live status. */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const found = await ids(ctx);
    if (!found) return invalidIdResponse();
    return forwardComputerCall(computerApiUrl(found.id, `/sessions/${found.sessionId}`), {
        method: 'GET',
        headers,
    });
});

/** Change the quality (or active channel) of an unfinished live view. */
export const PATCH = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const found = await ids(ctx);
    if (!found) return invalidIdResponse();
    const body = sanitizeUpdateBody(await readJsonBody(request));
    return forwardComputerCall(computerApiUrl(found.id, `/sessions/${found.sessionId}`), {
        method: 'PATCH',
        headers,
        body,
    });
});

/** End a live view. Idempotent upstream. */
export const DELETE = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const found = await ids(ctx);
    if (!found) return invalidIdResponse();
    return forwardComputerCall(computerApiUrl(found.id, `/sessions/${found.sessionId}`), {
        method: 'DELETE',
        headers,
    });
});

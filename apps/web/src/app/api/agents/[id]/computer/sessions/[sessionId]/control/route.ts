import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeControlBody,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

async function ids(ctx: RouteContext): Promise<{ id: string; sessionId: string } | null> {
    const { id, sessionId } = await ctx.params;
    return isUuid(id) && isUuid(sessionId) ? { id, sessionId } : null;
}

/**
 * Agent computers — control of the machine, from one live view.
 *
 *   GET     who holds control, until when, and any pending request
 *   POST    take control (`{}`), or ask whoever holds it (`{ request: true }`)
 *   DELETE  give control back
 *
 * Thin forwards with the session bearer and the workspace scope. The
 * platform's status passes through unchanged: 403 names the control policy,
 * 409 names who holds control or why the act does not fit the moment, and
 * every answer carries the control state the surface renders.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const found = await ids(ctx);
    if (!found) return invalidIdResponse();
    return forwardComputerCall(computerApiUrl(found.id, `/sessions/${found.sessionId}/control`), {
        method: 'GET',
        headers,
    });
});

export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const found = await ids(ctx);
    if (!found) return invalidIdResponse();
    const body = sanitizeControlBody(await readJsonBody(request));
    return forwardComputerCall(computerApiUrl(found.id, `/sessions/${found.sessionId}/control`), {
        method: 'POST',
        headers,
        body,
    });
});

export const DELETE = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const found = await ids(ctx);
    if (!found) return invalidIdResponse();
    return forwardComputerCall(computerApiUrl(found.id, `/sessions/${found.sessionId}/control`), {
        method: 'DELETE',
        headers,
    });
});

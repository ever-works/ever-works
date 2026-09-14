import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeOpenBody,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Agent computers — open a live view of the Agent's computer.
 *
 * Forwards `{ nodeId?, channels?, quality? }` (rebuilt from an allow-list)
 * with the session bearer and the workspace scope, and passes the platform's
 * answer through: `202 { sessionId }`, or a refusal whose status and named
 * reason the page renders as its own state (stopped, cannot be watched, a
 * channel it cannot serve, too many live views).
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeOpenBody(await readJsonBody(request));
    return forwardComputerCall(computerApiUrl(id, '/sessions'), { method: 'POST', headers, body });
});

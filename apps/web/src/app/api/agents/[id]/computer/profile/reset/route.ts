import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Agent computers — reset one Agent's logins and files on one computer.
 *
 * Forwards exactly `{ nodeId, confirmAgentName }`. The platform refuses a
 * mismatched name (422) and a reset while that Agent is working on that
 * computer (409); both statuses pass through with their named reason.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    if (!isUuid(raw.nodeId) || typeof raw.confirmAgentName !== 'string') {
        return new Response(JSON.stringify({ error: 'nodeId and confirmAgentName are required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    return forwardComputerCall(computerApiUrl(id, '/profile/reset'), {
        method: 'POST',
        headers,
        body: { nodeId: raw.nodeId, confirmAgentName: raw.confirmAgentName.slice(0, 200) },
    });
});

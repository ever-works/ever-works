import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string; sessionId: string }> };

/** Agent computers — extend the current stretch of control, once. */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, sessionId } = await ctx.params;
    if (!isUuid(id) || !isUuid(sessionId)) return invalidIdResponse();
    return forwardComputerCall(computerApiUrl(id, `/sessions/${sessionId}/control/extend`), {
        method: 'POST',
        headers,
    });
});

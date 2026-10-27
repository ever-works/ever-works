import { bffProxy } from '@/lib/api/bff-proxy';
import {
    appRuntimeApiUrl,
    forwardAppRuntimeCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string; requestId: string }> };

/**
 * Lane aw-ops — the logs drawer's poll: `GET /api/works/:id/app-logs/:requestId` (FR-48).
 * `pending` until the worker answers, then `ready` with the tail (already redacted by the API) or
 * `failed` with a code; 404 once it expired (5 minutes) or for another App Work's request id.
 * The drawer keeps the tail in memory only — nothing is written to the browser's storage.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, requestId } = await ctx.params;
    if (!isUuid(id) || !isUuid(requestId)) return invalidIdResponse();
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, `/app-logs/${requestId}`), {
        method: 'GET',
        headers,
    });
});

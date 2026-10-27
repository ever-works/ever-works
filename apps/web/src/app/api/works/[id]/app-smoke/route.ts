import { bffProxy } from '@/lib/api/bff-proxy';
import {
    appRuntimeApiUrl,
    forwardAppRuntimeCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Lane aw-ops — **Run smoke checks**: `POST /api/works/:id/app-smoke` (FR-36/FR-37). The result
 * lands on the live Deployment and is read back through the status poll's `smoke`.
 */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, '/app-smoke'), { method: 'POST', headers });
});

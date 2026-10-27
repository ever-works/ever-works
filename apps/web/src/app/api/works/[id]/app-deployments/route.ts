import { bffProxy } from '@/lib/api/bff-proxy';
import {
    appRuntimeApiUrl,
    forwardAppRuntimeCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Lane aw-ops — the Deploy tab's history table: `GET /api/works/:id/app-deployments` (T39). The
 * last 20 Deployments as ids, states, Build, commit, digest, times and a smoke count. Re-read
 * after a deploy, a rollback or a lifecycle action finishes.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, '/app-deployments'), {
        method: 'GET',
        headers,
    });
});

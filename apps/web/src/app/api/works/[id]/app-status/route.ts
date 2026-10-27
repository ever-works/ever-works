import { bffProxy } from '@/lib/api/bff-proxy';
import {
    appRuntimeApiUrl,
    forwardAppRuntimeCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * APW-06 T36 (lane aw-ops) — the Deploy tab's status poll: `GET /api/works/:id/app-status`.
 *
 * `AppDeployProgress` / the live card poll this every 3 s while a Deployment runs and every 30 s
 * otherwise (plan §10.2). A poll cannot be a server action — Next queues an action behind the one
 * already running, and the thing being polled is exactly the job a Deploy action just queued
 * (the reason `works/[id]/upstream/route.ts` gives) — so it is this route handler.
 *
 * `bffProxy` reads the session cookie (401 without it) and forwards the workspace scope (400 when
 * the per-tab selector is missing). The API resolves access and answers the unknown-id 404 for a
 * Work the caller cannot see; that status and body pass through unchanged.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, '/app-status'), { method: 'GET', headers });
});

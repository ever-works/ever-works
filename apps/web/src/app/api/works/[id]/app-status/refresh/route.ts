import { bffProxy } from '@/lib/api/bff-proxy';
import { appRuntimeApiUrl, forwardAppRuntimeCall, invalidIdResponse, isUuid } from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Lane aw-ops — **Refresh** on the live card: `POST /api/works/:id/app-status/refresh` (FR-46).
 * Answers 202 with a request id; a second press inside 15 s comes back `429 refresh_too_soon`
 * with its wait (body and `Retry-After`), which the card turns into a countdown.
 */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, '/app-status/refresh'), { method: 'POST', headers });
});

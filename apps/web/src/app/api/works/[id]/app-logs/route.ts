import { bffProxy } from '@/lib/api/bff-proxy';
import {
    appRuntimeApiUrl,
    forwardAppRuntimeCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
    sanitizeLogsBody,
} from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Lane aw-ops — the logs drawer's fetch: `POST /api/works/:id/app-logs` (FR-48).
 *
 * Forwards exactly `{ component | job, deploymentId?, previous?, lines? }`, rebuilt from an
 * allow-list. The platform answers 202 with a request id; the drawer then polls
 * `GET …/app-logs/:requestId`. Logs are for members who can deploy — the API answers a viewer 403.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const body = sanitizeLogsBody(await readJsonBody(request));
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, '/app-logs'), {
        method: 'POST',
        headers,
        body,
    });
});

import { bffProxy } from '@/lib/api/bff-proxy';
import {
    appRuntimeApiUrl,
    forwardAppRuntimeCall,
    invalidIdResponse,
    isRuntimeName,
    isUuid,
    readJsonBody,
} from '@/lib/api/app-runtime-bff';

type RouteContext = { params: Promise<{ id: string; name: string }> };

/**
 * Lane aw-ops — **Run now** on a job: `POST /api/works/:id/app-jobs/:name/run` (FR-51).
 *
 * Forwards `{ confirmFirstDeploy: true }` only when the member confirmed in the run dialog (the
 * literal `true`, nothing else); the platform refuses an unconfirmed run `422
 * job_confirmation_required`, and `409 deploy_in_progress` / `job_active` while it cannot start.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, name } = await ctx.params;
    let job = '';
    try {
        job = decodeURIComponent(name ?? '');
    } catch {
        return invalidIdResponse();
    }
    if (!isUuid(id) || !isRuntimeName(job)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    return forwardAppRuntimeCall(appRuntimeApiUrl(id, `/app-jobs/${encodeURIComponent(job)}/run`), {
        method: 'POST',
        headers,
        body: raw.confirmFirstDeploy === true ? { confirmFirstDeploy: true } : {},
    });
});

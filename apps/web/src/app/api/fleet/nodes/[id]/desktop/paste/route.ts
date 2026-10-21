import { isFleetClipText, isFleetClipViewId } from '@ever-works/contracts';
import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Paste into a desktop (FL-11 P2, FR-30…FR-35) — text from the person's own
 * clipboard into one live view's computer. The body is rebuilt from the three
 * fields the platform accepts; text over 256 KB (UTF-8) is refused here before
 * it leaves the web tier, and the platform measures it again.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    if (!isFleetClipViewId(raw.viewId) || !isUuid(raw.agentId)) return invalidIdResponse();
    if (!isFleetClipText(raw.text)) {
        return Response.json(
            {
                error: {
                    code: 'limit_exceeded',
                    hint: 'A paste carries at most 256 KB of text',
                    details: {},
                },
            },
            { status: 429 },
        );
    }
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/desktop/paste`), {
        method: 'POST',
        headers,
        body: { viewId: raw.viewId, agentId: raw.agentId, text: raw.text },
    });
});

import { bffProxy } from '@/lib/api/bff-proxy';
import {
    computerApiUrl,
    forwardComputerCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/computer-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Agent computers — the Agent's own logins and files on one computer.
 *
 * The page server-renders this for the computer it opens on; the profile
 * panel reads it here for any other computer the owner switches to. Both
 * ids are checked before anything leaves the web tier, and the platform's
 * answer passes through: the view, or `404 { reason: 'profile-not-found' }`
 * when the Agent has never opened anything on that computer.
 */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    const nodeId = new URL(request.url).searchParams.get('nodeId');
    if (!isUuid(id) || !isUuid(nodeId)) return invalidIdResponse();
    return forwardComputerCall(
        computerApiUrl(id, `/profile?nodeId=${encodeURIComponent(nodeId)}`),
        { method: 'GET', headers },
    );
});

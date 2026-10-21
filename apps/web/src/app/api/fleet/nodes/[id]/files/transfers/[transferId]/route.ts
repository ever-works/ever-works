import { bffProxy } from '@/lib/api/bff-proxy';
import {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string; transferId: string }> };

const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Files on computers (FL-11, FR-14, U15) — cancel a running transfer. */
export const DELETE = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id, transferId } = await ctx.params;
    if (!isUuid(id) || !isUuid(transferId)) return invalidIdResponse();
    const operationId = new URL(request.url).searchParams.get('operationId');
    const query =
        operationId && OPERATION_ID.test(operationId) ? `?operationId=${operationId}` : '';
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/transfers/${transferId}${query}`), {
        method: 'DELETE',
        headers,
    });
});

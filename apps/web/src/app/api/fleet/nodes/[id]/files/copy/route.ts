import { bffProxy } from '@/lib/api/bff-proxy';
import {
    filesLocation,
    filesNames,
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    invalidLocationResponse,
    isUuid,
    readJsonBody,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Files on computers (FL-11 P2, FR-24…FR-29) — copy entries to another
 * computer through Ever Works (the two machines never connect). The body is
 * rebuilt field by field: the source folder and entries, the destination
 * computer / root / folder, the conflict policy and the `confirm` a
 * credential-shaped file needs. The platform answers 202 with the transfer.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    const from = filesLocation(raw);
    const entries = filesNames(raw.entries);
    const target = raw.to && typeof raw.to === 'object' ? (raw.to as Record<string, unknown>) : {};
    const to = filesLocation(target);
    if (!from || !entries || !to || !isUuid(target.nodeId)) return invalidLocationResponse();
    const body: Record<string, unknown> = {
        root: from.root,
        path: from.path,
        entries,
        to: { nodeId: target.nodeId, root: to.root, path: to.path },
    };
    if (raw.replaceAll === true) body.replaceAll = true;
    const replace = filesNames(raw.replace);
    if (replace) body.replace = replace;
    if (raw.confirm === true) body.confirm = true;
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/files/copy`), {
        method: 'POST',
        headers,
        body,
    });
});

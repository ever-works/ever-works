import { bffProxy } from '@/lib/api/bff-proxy';
import {
    filesUpstreamQuery,
    fleetApiUrl,
    invalidIdResponse,
    invalidLocationResponse,
    isUuid,
} from '@/lib/api/fleet-files-bff';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Files on computers (FL-11, FR-12…FR-15) — upload into a folder. The body is
 * the files stream the Files tab built from the picked files (a lazy Blob of
 * contract records, `application/octet-stream`); it is PIPED to the platform
 * (`duplex: 'half'`), never buffered here, so a 2 GiB upload passes through
 * without the web tier holding it. The query is rebuilt from an allow-list
 * (`root`, `path`, `replaceAll`, `replace`, `entries`, `bytes`, `label`).
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const query = filesUpstreamQuery(new URL(request.url).searchParams, {
        single: ['replaceAll', 'entries', 'bytes', 'label'],
        repeated: ['replace'],
    });
    if (query === null) return invalidLocationResponse();
    if (!request.body) return invalidLocationResponse();
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/octet-stream');
    const length = request.headers.get('content-length');
    if (length && /^\d+$/.test(length)) headers.set('Content-Length', length);
    const upstream = await fetch(fleetApiUrl(`/nodes/${id}/files/upload${query}`), {
        method: 'POST',
        headers,
        body: request.body,
        cache: 'no-store',
        // Stream the request body (Node's fetch needs it said out loud).
        duplex: 'half',
    } as RequestInit);
    const text = await upstream.text().catch(() => '');
    return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
});

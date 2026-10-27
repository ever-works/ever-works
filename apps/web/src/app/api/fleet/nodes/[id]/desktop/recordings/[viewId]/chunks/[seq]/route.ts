import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, invalidIdResponse, isUuid } from '@/lib/api/fleet-desktop-bff';

type RouteContext = { params: Promise<{ id: string; viewId: string; seq: string }> };

/**
 * Desktop view & control (FL-07 P2.C) — one recording chunk, passed through
 * as bytes: never sniffed, never cached, always an attachment.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, viewId, seq } = await ctx.params;
    if (!isUuid(id) || !isUuid(viewId) || !/^\d{1,6}$/.test(seq)) return invalidIdResponse();
    headers.set('Accept', 'application/octet-stream');
    const upstream = await fetch(
        fleetApiUrl(`/nodes/${id}/desktop/recordings/${viewId}/chunks/${seq}`),
        {
            method: 'GET',
            headers,
            cache: 'no-store',
        },
    );
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    const bytes = await upstream.arrayBuffer();
    return new Response(bytes, {
        status: 200,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="desktop-recording-${seq}.ewrec"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
        },
    });
});

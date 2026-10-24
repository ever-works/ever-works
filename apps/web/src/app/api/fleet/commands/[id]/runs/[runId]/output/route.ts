import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, invalidIdResponse, isUuid } from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string; runId: string }> };

/** Never echo a caller-controlled value into a response header. */
const FALLBACK_DISPOSITION = 'attachment; filename="command-output.log"';

/**
 * Commands on computers (FL-12 P2, spec FR-6, FR-18) —
 * `GET /api/fleet/commands/:id/runs/:runId/output`: one computer's FULL output
 * of one of the person's Commands, read from the computer (which keeps its last
 * 30 runs). The upstream body is PIPED through, never buffered; a refusal
 * (`unreachable` — the computer is offline — or `not_found`) passes through as
 * the CONTRACTS §8 envelope with its status, so the card can say why.
 */
export const GET = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    const { id, runId } = await ctx.params;
    if (!isUuid(id) || !isUuid(runId)) return invalidIdResponse();
    headers.set('Accept', 'text/plain, application/json');
    const upstream = await fetch(fleetApiUrl(`/commands/${id}/runs/${runId}/output`), {
        method: 'GET',
        headers,
        cache: 'no-store',
    });
    if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status || 502,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    const upstreamDisposition = upstream.headers.get('content-disposition');
    const disposition =
        upstreamDisposition && !/[\r\n]/.test(upstreamDisposition) ? upstreamDisposition : FALLBACK_DISPOSITION;
    return new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': disposition,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        },
    });
});

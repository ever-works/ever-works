import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

type RouteContext = { params: Promise<{ id: string; runId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Streaming-terminal M9 — persisted-transcript replay proxy.
 *
 * Sibling of the attach-token / start proxies: the browser holds a web
 * session cookie, not an API bearer, and does not know the API origin.
 *
 * Only `fromSeq` and `limit` are forwarded, and only after being
 * re-parsed as non-negative integers here — the upstream clamps them
 * again, but a proxy should never relay an unvalidated query string.
 * Upstream status passes through UNCHANGED so the pane can tell "not
 * yours / gone" (404) from "transcripts are off on this install"
 * (an empty page) from a transport failure.
 *
 * Auth and workspace scope come from {@link bffProxy}: no session cookie is
 * `401 Unauthorized`, a missing or malformed per-tab selector is
 * `400 Invalid workspace scope`, and the handler is handed headers that
 * already carry the session bearer and the Organization scope.
 */
export const GET = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    // Runs inside the wrapper, so auth and scope are already settled here.
    const { id, runId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(runId)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const query = new URLSearchParams();
    for (const name of ['fromSeq', 'limit'] as const) {
        const raw = request.nextUrl.searchParams.get(name);
        if (raw === null) continue;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
            query.set(name, String(parsed));
        }
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';

    // bffProxy supplies the bearer and the scope header; the JSON `Accept`
    // this proxy has always sent upstream is added on top of them.
    headers.set('Accept', 'application/json');

    const upstream = await fetch(
        `${API_URL}/agents/${id}/runs/${runId}/terminal/transcript${suffix}`,
        {
            method: 'GET',
            headers,
            cache: 'no-store',
        },
    );

    const text = await upstream.text().catch(() => '');
    return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
});

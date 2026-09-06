import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

type RouteContext = { params: Promise<{ id: string; runId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Streaming-terminal — start-session proxy.
 *
 * Sibling of the attach-token proxy: the browser holds a web session
 * cookie, not an API bearer, and does not know the API origin. This
 * forwards the start with the session bearer and passes the upstream
 * status through UNCHANGED — 409 ("a session is already live", "the run
 * has finished") and 404 are the whole point of the endpoint, so they must
 * reach the pane instead of being flattened into a generic failure.
 *
 * No request body is forwarded: the session argv is operator configuration
 * resolved server-side, never something the browser gets to choose.
 *
 * Auth and workspace scope come from {@link bffProxy}: no session cookie is
 * `401 Unauthorized`, a missing or malformed per-tab selector is
 * `400 Invalid workspace scope`, and the handler is handed headers that
 * already carry the session bearer and the Organization scope.
 */
export const POST = bffProxy<RouteContext>(async ({ headers }, ctx) => {
    // Runs inside the wrapper, so auth and scope are already settled here.
    const { id, runId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(runId)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    // bffProxy supplies the bearer and the scope header; the JSON `Accept`
    // this proxy has always sent upstream is added on top of them.
    headers.set('Accept', 'application/json');

    const upstream = await fetch(`${API_URL}/agents/${id}/runs/${runId}/terminal/start`, {
        method: 'POST',
        headers,
        cache: 'no-store',
    });

    const text = await upstream.text().catch(() => '');
    return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
});

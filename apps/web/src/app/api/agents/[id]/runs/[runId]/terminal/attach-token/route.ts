import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

type RouteContext = { params: Promise<{ id: string; runId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Streaming-terminal M7 — attach-token proxy.
 *
 * The browser cannot call the API attach endpoint directly (session
 * auth lives in the web cookie), and it cannot know the API origin for
 * the WebSocket leg (`API_URL` is a server env). This proxy does both:
 * forwards the mint with the session bearer, and rewrites the relative
 * `wsPath` into an ABSOLUTE `wsUrl` derived from `API_URL`
 * (http→ws / https→wss) — so cloud installs get
 * `wss://api.…/ws/terminal/:runId` and local dev gets
 * `ws://localhost:3100/…` from the same code.
 *
 * The token itself is a 60s single-run credential; it rides the JSON
 * response (never a URL) and the browser presents it as the first WS
 * message.
 *
 * Auth and workspace scope come from {@link bffProxy}: no session cookie is
 * `401 Unauthorized`, a missing or malformed per-tab selector is
 * `400 Invalid workspace scope`, and the handler is handed headers that
 * already carry the session bearer and the Organization scope.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    // Runs inside the wrapper, so auth and scope are already settled here.
    const { id, runId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(runId)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    // Only the read-only downgrade is forwarded — never a raw
    // caller-supplied role. The API clamps too; this keeps the proxy
    // from being the place a new role could be smuggled in.
    const roleQuery = request.nextUrl.searchParams.get('role') === 'viewer' ? '?role=viewer' : '';

    // bffProxy supplies the bearer and the scope header; the JSON `Accept`
    // this proxy has always sent upstream is added on top of them.
    headers.set('Accept', 'application/json');

    const upstream = await fetch(
        `${API_URL}/agents/${id}/runs/${runId}/terminal/attach-token${roleQuery}`,
        {
            method: 'POST',
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

    const body = (await upstream.json().catch(() => null)) as {
        token: string;
        wsPath: string;
        role: string;
        expiresInSec: number;
    } | null;
    if (!body?.token || !body.wsPath) {
        return NextResponse.json({ error: 'Malformed upstream response' }, { status: 502 });
    }

    // API_URL ends in /api — the WS gateway hangs off the ORIGIN.
    const origin = API_URL.replace(/\/api$/, '');
    const wsUrl = origin.replace(/^http/, 'ws') + body.wsPath;

    return NextResponse.json(
        { token: body.token, wsUrl, role: body.role, expiresInSec: body.expiresInSec },
        { headers: { 'Cache-Control': 'no-store' } },
    );
});

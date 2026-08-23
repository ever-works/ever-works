import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

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
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
    const { id, runId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(runId)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

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
}

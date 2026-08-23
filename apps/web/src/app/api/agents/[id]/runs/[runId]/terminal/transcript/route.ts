import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

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
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
    const { id, runId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(runId)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

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
}

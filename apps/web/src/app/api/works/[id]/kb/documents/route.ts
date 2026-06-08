import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * EW-641 — read-only proxy for the KB document LIST endpoint
 * (`GET /api/works/:id/kb/documents`).
 *
 * The workbench tree panel (`KbTreePanel`), the `@`-mention suggester, and
 * the CmdK search palette all fetch this list CLIENT-side to populate the
 * per-Work document tree. Without this route the browser request hit the
 * Next.js app with no matching handler → 404 → `KbTreePanel` fell into its
 * error state and rendered an EMPTY tree, which broke every workbench UI
 * flow (no group toggles, no rows, editor never reachable from the index).
 * The old `works/detail/kb` tree got its list via server-side props, so the
 * gap only surfaced once the client-fetching workbench landed.
 *
 * Mirrors the sibling `tags` / `search` / `uploads` proxies: cookie JWT →
 * `Authorization: Bearer` and the API base URL stay server-side. The query
 * string (`?q=&limit=&class=` …) is forwarded verbatim so the mention /
 * search callers' filters reach the API. Read-only (GET); document
 * mutations go through the per-doc routes + the uploads endpoint.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const search = request.nextUrl.search;
    const upstream = await fetch(`${API_URL}/works/${id}/kb/documents${search}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { items: [], total: 0 }, { status: 200 });
}

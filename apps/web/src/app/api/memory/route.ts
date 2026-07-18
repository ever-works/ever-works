import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Org-wide Memory (Cortex P1) — read-only same-origin proxy for the
 * aggregation endpoint (`GET /api/memory`).
 *
 * The Memory page's client shell fetches this route when the user types
 * in the search box or toggles a filter chip, so the browser keeps its
 * same-origin fetch pattern (cookie JWT → `Authorization: Bearer`, API
 * base URL stays server-side). The query string (`?q=&type=&work=…`) is
 * forwarded verbatim. Mirrors the per-Work KB list proxy
 * (`app/api/works/[id]/kb/documents/route.ts`).
 *
 * The active Organization is resolved by the API from the request scope
 * context (the session's last-active Org), not a param — so there is
 * nothing org-specific to forward here.
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const search = request.nextUrl.search;
    const upstream = await fetch(`${API_URL}/memory${search}`, {
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
    return NextResponse.json(
        body ?? {
            documents: [],
            counts: { documents: 0 },
            facets: { types: [], works: [], statuses: [], sources: [] },
        },
        { status: 200 },
    );
}

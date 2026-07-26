import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Memory health (memory upgrades M10) — read-only same-origin proxy for
 * `GET /api/memory/health`.
 *
 * The health panel in the KB workbench fetches this CLIENT-side, so the
 * browser keeps its same-origin fetch pattern (cookie JWT →
 * `Authorization: Bearer`, API base URL stays server-side). The query
 * string (`?windowDays=&staleAfterDays=`) is forwarded verbatim.
 *
 * The active Organization is resolved by the API from the request scope
 * context, never a param — so there is nothing org-specific to forward.
 * An org-less session gets the empty payload (all counts 0, every rate
 * `null`), which the panel renders as "not measurable yet".
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const search = request.nextUrl.search;
    const upstream = await fetch(`${API_URL}/memory/health${search}`, {
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
    return NextResponse.json(body, { status: 200 });
}

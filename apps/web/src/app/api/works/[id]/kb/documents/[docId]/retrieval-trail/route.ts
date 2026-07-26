import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * "Ask why" (memory upgrades M11) — read-only same-origin proxy for
 * `GET /api/works/:id/kb/documents/:docId/retrieval-trail`.
 *
 * The decision document's "Ask why" panel fetches this CLIENT-side when
 * the reader expands it (never eagerly — the trail is a diagnostic, not
 * part of reading the document). Mirrors the sibling `history` /
 * `citations` proxies: cookie JWT → `Authorization: Bearer`, API base
 * URL stays server-side, query string forwarded verbatim.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id, docId } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const search = request.nextUrl.search;
    const upstream = await fetch(
        `${API_URL}/works/${id}/kb/documents/${docId}/retrieval-trail${search}`,
        {
            method: 'GET',
            headers,
            cache: 'no-store',
        },
    );

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

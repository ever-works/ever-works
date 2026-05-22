import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * EW-641 Phase 1B/d row 15 — lexical KB search proxy for the CmdK
 * palette.
 *
 * Phase 1A shipped `q` as a filter on `GET /works/:id/kb/documents`
 * (Postgres FTS across title + description + body — see
 * `KbDocumentListFilter.q` in `@ever-works/contracts`). Rather than
 * spinning up a parallel `/search` route on the agent side we proxy
 * straight to that endpoint here. The row 30 RRF rewrite (Phase 2)
 * will swap the underlying ranker without changing this contract.
 *
 * `GET /api/works/:id/kb/search?q=&limit=`
 *   200 → `{ items: KbDocumentDto[]; total: number }` (verbatim
 *         passthrough from the upstream).
 *
 * Server-side proxy keeps the JWT cookie + `API_URL` resolution on the
 * server (matches `kb/tags` and `kb/uploads`). Empty `q` short-circuits
 * to an empty result so the client doesn't have to special-case it.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
    const limitRaw = request.nextUrl.searchParams.get('limit');
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), 50) : 20;

    if (q.length === 0) {
        return NextResponse.json({ items: [], total: 0 }, { status: 200 });
    }

    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstreamParams = new URLSearchParams();
    upstreamParams.set('q', q);
    upstreamParams.set('limit', String(limit));

    const upstream = await fetch(
        `${API_URL}/works/${id}/kb/documents?${upstreamParams.toString()}`,
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

    const json = await upstream.json().catch(() => null);
    return NextResponse.json(json ?? { items: [], total: 0 }, { status: 200 });
}

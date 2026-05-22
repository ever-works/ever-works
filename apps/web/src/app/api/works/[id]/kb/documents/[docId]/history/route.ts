import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * EW-641 Phase 1B/d row 18c — KB document history proxy.
 *
 * Forwards `GET /api/works/:id/kb/documents/:docId/history?limit=N`
 * to the upstream NestJS endpoint shipped in row 18a (PR #943). The
 * upstream returns `{ items: KbDocumentCommitDto[] }`; the real
 * git-log walk lands in row 18b — until then the upstream returns
 * an empty list, which the dialog already handles via its empty state.
 *
 * Same JWT-cookie-forwarding shape as the row-14 lock proxy.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id, docId } = await params;
    const limit = request.nextUrl.searchParams.get('limit') ?? '';
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstreamParams = new URLSearchParams();
    if (limit && /^\d+$/.test(limit)) {
        upstreamParams.set('limit', limit);
    }
    const query = upstreamParams.toString() ? `?${upstreamParams.toString()}` : '';

    const upstream = await fetch(
        `${API_URL}/works/${encodeURIComponent(id)}/kb/documents/${encodeURIComponent(docId)}/history${query}`,
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
    return NextResponse.json(json ?? { items: [] }, { status: 200 });
}

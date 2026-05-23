import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * EW-641 Phase 1B/d row 14 — proxy for the KB document unlock endpoint.
 *
 * `POST /api/works/:id/kb/documents/:docId/unlock`
 *   no body
 *   200   → updated `KbDocumentDto`
 */
export async function POST(_request: NextRequest, { params }: RouteContext) {
    const { id, docId } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(
        `${API_URL}/works/${id}/kb/documents/${encodeURIComponent(docId)}/unlock`,
        {
            method: 'POST',
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
    return NextResponse.json(json ?? null, { status: 200 });
}

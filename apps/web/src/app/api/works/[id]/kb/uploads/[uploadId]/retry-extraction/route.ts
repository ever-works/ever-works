import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; uploadId: string }> };

/**
 * Proxy for `POST /api/works/:id/kb/uploads/:uploadId/retry-extraction`.
 *
 * The API has implemented retry since Phase 1B, but no web route existed,
 * so the only recovery path for a FAILED extraction was a direct API call
 * — unreachable from the browser. The Originals tab now surfaces a Retry
 * action on failed rows, which needs this.
 *
 * Retry is deliberately a POST with no body: the upload row and its stored
 * bytes are the whole input, and re-sending metadata would let a client
 * silently reclassify a document under the guise of retrying it.
 */
export async function POST(_request: NextRequest, { params }: RouteContext) {
    const { id, uploadId } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(
        `${API_URL}/works/${id}/kb/uploads/${uploadId}/retry-extraction`,
        { method: 'POST', headers, cache: 'no-store' },
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
    return NextResponse.json(body ?? {}, { status: upstream.status });
}

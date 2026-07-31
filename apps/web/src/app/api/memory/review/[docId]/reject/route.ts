import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy for `POST /api/memory/review/:docId/reject`.
 *
 * Rejecting ARCHIVES the document — it is not a delete, and the upstream
 * refuses ids outside the caller's Organization with a 404 rather than a
 * 403 so the endpoint cannot be used to probe which ids exist elsewhere.
 * None of that is decided here; this only forwards the caller's bearer.
 */
export async function POST(_request: NextRequest, { params }: RouteContext) {
    const { docId } = await params;
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const upstream = await fetch(`${API_URL}/memory/review/${encodeURIComponent(docId)}/reject`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
    });

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                'Cache-Control': 'no-store',
            },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? {}, { status: 200 });
}

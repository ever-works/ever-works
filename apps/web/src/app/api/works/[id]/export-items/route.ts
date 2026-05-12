import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Proxies `GET /api/works/[id]/export-items?format=csv|xlsx` from the browser
 * to the NestJS API server-side, attaching the session token from the
 * `auth-access` cookie. The upstream response body (CSV text or XLSX bytes)
 * is streamed straight through so binary downloads work without buffering.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/works/${id}/export-items${request.nextUrl.search}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return NextResponse.json(
            { error: 'Item export failed', detail },
            { status: upstream.status || 500 },
        );
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'Content-Disposition': upstream.headers.get('content-disposition') ?? 'attachment',
            'Cache-Control': 'no-store',
        },
    });
}

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Proxies `GET /api/works/[id]/import-items/sample?format=csv|xlsx`. Streams
 * the upstream body straight through so the browser triggers a file save
 * via Content-Disposition.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(
        `${API_URL}/works/${id}/import-items/sample${request.nextUrl.search}`,
        {
            method: 'GET',
            headers,
            cache: 'no-store',
        },
    );

    if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        return NextResponse.json(
            { error: 'Import sample download failed', detail },
            { status: upstream.status || 500 },
        );
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type':
                upstream.headers.get('content-type') ?? 'application/octet-stream',
            'Content-Disposition':
                upstream.headers.get('content-disposition') ?? 'attachment',
            'Cache-Control': 'no-store',
        },
    });
}

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * FU-5 — multipart upload proxy for Task attachments.
 *
 * Forwards `POST /api/uploads` from the browser to the NestJS API.
 * Streams the request body upstream so the multipart boundary stays
 * intact (NestJS's FileInterceptor parses it on the upstream side).
 *
 * Mirrors the work-scoped KB upload proxy at
 * `apps/web/src/app/api/works/[id]/kb/uploads/route.ts` so behaviour
 * is consistent: auth cookie → Authorization Bearer, no caching,
 * upstream status + body surfaced verbatim on error so the client
 * sees the right 413 / 415 / 400 messaging.
 */
export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const upstream = await fetch(`${API_URL}/uploads`, {
        method: 'POST',
        headers,
        body: request.body,
        duplex: 'half',
        cache: 'no-store',
    } as RequestInit & { duplex: 'half' });

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

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * EW-641 Phase 1B/d row 7 — multipart upload proxy.
 *
 * Forwards `POST /api/works/[id]/kb/uploads` from the browser to the
 * NestJS API. The browser submits multipart/form-data with a `file`
 * part + optional `targetClass`, `title`, `description`, `tags`
 * fields; we stream the request body upstream so the multipart
 * boundary stays intact — NestJS's `FileInterceptor` parses it on
 * the upstream side.
 *
 * Mirrors `import-items/validate/route.ts` (the only other multipart
 * proxy in this app) so behaviour is consistent: auth cookie →
 * `Authorization: Bearer`, `cache: 'no-store'`, surface the upstream
 * status + body verbatim on error so the client can show the right
 * 413 / 503 / 400 messaging.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) {
        headers.set('Content-Type', contentType);
    }
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/works/${id}/kb/uploads`, {
        method: 'POST',
        headers,
        body: request.body,
        // Required for streaming request bodies on Node's fetch.
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

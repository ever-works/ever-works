import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Multipart upload proxy for the broader-than-image PromptComposer
 * uploads (PDFs, ZIP / Office docs, text / markdown / code, plus
 * images).
 *
 * Forwards `POST /api/uploads/file` from the browser to the NestJS API
 * controller of the same name. Streams the request body upstream so the
 * multipart boundary stays intact (NestJS's `FileInterceptor` parses it
 * on the upstream side).
 *
 * Mirrors the existing image-upload proxy at `../route.ts` — auth
 * cookie → Authorization Bearer, no caching, upstream status + body
 * surfaced verbatim on error so the client sees the right
 * 400 / 413 / 415 messaging.
 *
 * The `workId` query string is forwarded as-is for backends that scope
 * storage per Work (currently `github-storage` in `data-repo` mode).
 */
export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);
    if (token) headers.set('Authorization', `Bearer ${token}`);

    // Security: allowlist only the documented query parameters instead of
    // forwarding the entire raw query string, which could pass unexpected
    // parameters to the NestJS controller.
    const upstreamUrl = new URL(`${API_URL}/uploads/file`);
    const workId = request.nextUrl.searchParams.get('workId');
    if (workId) upstreamUrl.searchParams.set('workId', workId);

    const upstream = await fetch(upstreamUrl.toString(), {
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

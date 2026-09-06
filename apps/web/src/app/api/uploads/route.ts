import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * FU-5 — multipart upload proxy (`POST /api/uploads`, image uploads).
 *
 * Streams the request body upstream so the multipart boundary stays
 * intact (NestJS's FileInterceptor parses it on the upstream side), and
 * surfaces the upstream status + body verbatim on error so the client
 * sees the right 413 / 415 / 400 messaging.
 *
 * **Workspace scope.** `UploadsController.upload` stamps the `user_uploads`
 * row from the REQUEST scope, so this proxy forwarding only the bearer
 * meant every upload — including from an `/org/<slug>/` tab — was persisted
 * as a personal row, invisible from that Organization. `bffProxy` converts
 * the browser's `x-ever-workspace` selector into `X-Scope-Slug` and fails
 * closed without it; the 401 for a missing cookie is unchanged and still
 * comes BEFORE any scope check. There is no in-app caller of this route
 * today; the e2e pin (`sec-pin-uploads-auth`) sends the selector.
 *
 * Sibling: `file/route.ts`. Do not model new routes on
 * `works/[id]/kb/uploads/route.ts` — that one is still unscoped.
 */
export const POST = bffProxy(async ({ request, headers }) => {
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);

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
});

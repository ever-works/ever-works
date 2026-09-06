import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * Multipart upload proxy for the broader-than-image PromptComposer
 * uploads (PDFs, ZIP / Office docs, text / markdown / code, plus
 * images) — `POST /api/uploads/file`, reached by `uploadFile()` in
 * `lib/api/uploads.ts` from the composers, chat attachments and the
 * Mission / Idea / Agent attachment sections.
 *
 * Streams the request body upstream so the multipart boundary stays
 * intact (NestJS's `FileInterceptor` parses it on the upstream side), and
 * surfaces the upstream status + body verbatim on error so the client
 * sees the right 400 / 413 / 415 messaging.
 *
 * **Workspace scope.** `UploadsController.uploadFile` stamps the
 * `user_uploads` row from the REQUEST scope. This proxy forwarded no
 * scope, so every org-tab upload landed as a personal row — which is also
 * why attaching it to an org Mission / Idea / Agent 404'd: the attach path
 * resolves the upload with the strict org branch of `ownershipWhereWith`.
 * `bffProxy` forwards the selector and fails closed without it; the XHR in
 * `uploadFile()` sets it. The 401 for a missing cookie is unchanged.
 *
 * The `workId` query string is forwarded for backends that scope storage
 * per Work (currently `github-storage` in `data-repo` mode). It stays the
 * ONLY forwarded key: the scope arrives as a header on this write route,
 * never as `?scope=` — that carrier belongs to the navigation-reached
 * serve route.
 */
export const POST = bffProxy(async ({ request, headers }) => {
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);

    // Security: allowlist only the documented query parameter instead of
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
});

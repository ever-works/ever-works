import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * Client-side proxy for `POST /api/skills/:id/files` — multipart
 * companion-file uploads go browser → this route → NestJS with the
 * session cookie translated to a Bearer (same posture as
 * `/api/uploads/file`). The multipart body is STREAMED upstream with its
 * Content-Type (`duplex: 'half'`), exactly like the sibling upload
 * proxies, so the boundary survives verbatim for NestJS's
 * `FileInterceptor` and the file never sits in this process's memory —
 * the previous version buffered it into a FormData and re-serialised it.
 *
 * **Workspace scope.** Both rows the API writes take their stamp from the
 * request scope — `user_uploads` through `recordUpload`'s
 * `scopeContext.getScope()` fallback, `skill_files` through
 * `ScopeStampingSubscriber` — so a proxy that forwarded only the bearer
 * stamped every org-tab companion file personal. `bffProxy` forwards the
 * selector (`SkillDetailClient` sends it via `browserApiFetch`) and fails
 * closed without it. It also answers a missing cookie with the BFF's own
 * `401 { error: 'Unauthorized' }` instead of forwarding bearer-less.
 */
export const POST = bffProxy<{ params: Promise<{ id: string }> }>(
    async ({ request, headers }, { params }) => {
        const { id } = await params;
        const contentType = request.headers.get('content-type');
        if (contentType) headers.set('Content-Type', contentType);

        const response = await fetch(`${API_URL}/skills/${encodeURIComponent(id)}/files`, {
            method: 'POST',
            headers,
            body: request.body,
            duplex: 'half',
            cache: 'no-store',
        } as RequestInit & { duplex: 'half' });

        const body = await response.json().catch(() => ({ error: 'Upload failed' }));
        return NextResponse.json(body, { status: response.status });
    },
);

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

/**
 * Proxy for global-Memory originals — `GET`/`POST /api/memory/uploads`.
 *
 * Mirrors the per-Work `works/[id]/kb/uploads` proxy exactly, minus the
 * `id` segment: the target Organization is resolved server-side from the
 * request scope, never from the URL, so there is no org id for a client
 * to tamper with.
 *
 * The POST body is streamed upstream rather than parsed here so the
 * multipart boundary survives intact for NestJS's `FileInterceptor`.
 *
 * **Workspace scope (EW-786).** "Resolved server-side from the request
 * scope" is precisely what stopped working: since `8f28edca0` the API
 * only sees an Organization through `X-Scope-Slug` (or an `/api/<slug>/`
 * path), and this proxy forwarded neither. Both handlers on
 * `OrgMemoryController` read `ScopeContextService.getOrganizationId()`,
 * and both fail SOFTLY without one — `listMemoryUploads` returns
 * `{ items: [], total: 0 }` with a 200, `createMemoryUpload` throws 422
 * — so the Originals panel showed an empty list and blamed the user's
 * org setup for uploads it had scoped away itself.
 *
 * `applyBffWorkspaceScope` converts the browser's per-tab
 * `x-ever-workspace` selector into `X-Scope-Slug` and overwrites any
 * client-supplied value; a missing or stale selector is a 400 here
 * rather than a silently personal-scoped answer. Callers must therefore
 * use `browserApiFetch` — see `components/memory/MemoryUploadsPanel.tsx`.
 */

export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const baseHeaders = new Headers();
    baseHeaders.set('Accept', 'application/json');
    if (token) {
        baseHeaders.set('Authorization', `Bearer ${token}`);
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, baseHeaders);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    const upstream = await fetch(`${API_URL}/memory/uploads${request.nextUrl.search}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { items: [], total: 0 }, { status: 200 });
}

export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const baseHeaders = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) {
        baseHeaders.set('Content-Type', contentType);
    }
    if (token) {
        baseHeaders.set('Authorization', `Bearer ${token}`);
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, baseHeaders);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    const upstream = await fetch(`${API_URL}/memory/uploads`, {
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

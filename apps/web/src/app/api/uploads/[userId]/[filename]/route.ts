import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScopeFromNavigation } from '@/lib/api/bff-scope';

type RouteContext = { params: Promise<{ userId: string; filename: string }> };

/**
 * Serve proxy for previously-uploaded files.
 *
 * Upload responses (and the attachment list endpoints) reference files
 * by the API-routed URL `/api/uploads/<userId>/<sha256>.<ext>` — but the
 * NestJS serve endpoint of the same path is owner-gated behind a Bearer
 * token the browser doesn't hold (auth lives in an HTTP-only cookie).
 * This route makes those URLs directly openable from an <a> tag: auth
 * cookie → Authorization Bearer, then the upstream file is streamed
 * back with its Content-Type and security headers intact.
 *
 * **Workspace scope.** Reached by `<a href>` / `<img src>`, which cannot
 * carry `x-ever-workspace`, so the selector travels as `?scope=` and is
 * turned into `X-Scope-Slug` here (`applyBffWorkspaceScopeFromNavigation`).
 * The URLs are API-MINTED and live in stored chat text and attachment
 * lists that predate any carrier, so a URL with no selector runs
 * personal — exactly what it got before, owner-gated by `userId` upstream.
 * A present-but-invalid selector is a 400. Upstream, `UploadsController.serve`
 * resolves the row in the request scope and answers an opaque 404 for a
 * same-user row that exists in another scope, so a client must only append
 * `?scope=org:<slug>` once org-tab uploads are STAMPED with that
 * Organization (the write proxies and the backfill) — until then this
 * server side is inert.
 *
 * Mirrors the sibling upload proxies (`../route.ts`, `../file/route.ts`)
 * for the auth + query-allowlist conventions.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
    const { userId, filename } = await params;
    const token = await getAuthAccessCookie();
    // Security: reject unauthenticated requests at the BFF layer instead
    // of proxying them upstream without credentials.
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    try {
        headers = applyBffWorkspaceScopeFromNavigation(request, headers);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    // Security: allowlist only the documented query parameter (workId —
    // round-tripped for per-Work storage backends) and encode the path
    // segments to prevent URL injection via crafted IDs. This is also what
    // keeps the `scope` carrier OFF the upstream URL: the Nest handler
    // takes `workId` only, and the global ValidationPipe rejects unknown
    // query keys.
    const upstreamUrl = new URL(
        `${API_URL}/uploads/${encodeURIComponent(userId)}/${encodeURIComponent(filename)}`,
    );
    const workId = request.nextUrl.searchParams.get('workId');
    if (workId) upstreamUrl.searchParams.set('workId', workId);

    const upstream = await fetch(upstreamUrl.toString(), {
        headers,
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

    // Stream the file body through, preserving the upstream's content
    // negotiation + the defense-in-depth headers the API sets against
    // inline rendering of attacker-uploaded active content.
    const passthrough = new Headers();
    for (const name of [
        'content-type',
        'content-length',
        'content-disposition',
        'content-security-policy',
        'x-content-type-options',
        'cache-control',
    ]) {
        const value = upstream.headers.get(name);
        if (value) passthrough.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: passthrough });
}

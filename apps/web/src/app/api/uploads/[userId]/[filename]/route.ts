import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

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

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);

    // Security: allowlist only the documented query parameter (workId —
    // round-tripped for per-Work storage backends) and encode the path
    // segments to prevent URL injection via crafted IDs.
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

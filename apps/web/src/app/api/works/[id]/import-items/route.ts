import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Proxies `POST /api/works/[id]/import-items` (EW-533 Phase 3, execute).
 * The body is a JSON `{ rows, duplicate_strategy, default_status }` payload
 * — same shape the wizard's Confirm step builds from the Phase 2 validate
 * response. The upstream NestJS handler clones the data repo, writes the
 * YAMLs, commits, pushes, and optionally opens a PR.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const body = await request.text();

    const upstream = await fetch(`${API_URL}/works/${id}/import-items`, {
        method: 'POST',
        headers,
        body,
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

    const data = await upstream.json().catch(() => null);
    return NextResponse.json(data ?? {}, { status: 200 });
}

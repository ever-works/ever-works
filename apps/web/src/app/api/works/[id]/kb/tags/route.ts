import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * EW-641 Phase 1B/d row 8 — read-only proxy for the KB tags endpoint.
 *
 * The classify modal opens client-side and needs to populate its
 * autocomplete with the Work's existing KB tags. Bouncing through this
 * proxy keeps the JWT cookie + API base URL handling server-side
 * (matches the existing `kb/uploads/route.ts` shape).
 *
 * Only GET is exposed for now; tag CRUD (create / update / delete)
 * lives in row 13 alongside the side-panel UI that needs it. Add
 * POST/PATCH/DELETE here when those land.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/works/${id}/kb/tags`, {
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
    return NextResponse.json(body ?? [], { status: 200 });
}

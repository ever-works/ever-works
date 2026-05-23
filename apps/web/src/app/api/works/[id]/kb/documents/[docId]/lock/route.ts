import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * EW-641 Phase 1B/d row 14 — proxy for the KB document lock endpoint.
 *
 * Bouncing through this proxy keeps the JWT cookie + API base URL
 * handling server-side (matches the existing `kb/tags` and `kb/uploads`
 * proxies). The upstream NestJS controller validates the body via
 * `LockKbDocumentDto` (class-validator `@IsIn(KB_LOCK_MODES)`), so we
 * forward the JSON body verbatim and let the API surface any 4xx.
 *
 * `POST /api/works/:id/kb/documents/:docId/lock`
 *   body  → `{ mode: 'full' | 'additions-only' }`
 *   200   → updated `KbDocumentDto`
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
    const { id, docId } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    // Pass the body through verbatim. We deliberately don't parse +
    // re-stringify — that would lose any trailing whitespace / extra
    // keys the API validator might want to reject explicitly.
    const body = await request.text();

    const upstream = await fetch(
        `${API_URL}/works/${id}/kb/documents/${encodeURIComponent(docId)}/lock`,
        {
            method: 'POST',
            headers,
            body,
            cache: 'no-store',
        },
    );

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const json = await upstream.json().catch(() => null);
    return NextResponse.json(json ?? null, { status: 200 });
}

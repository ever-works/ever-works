import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Memory Consolidation — same-origin proxy for the consolidation pass
 * (`POST /api/memory/consolidate`).
 *
 * The Memory page's client shell posts here twice per consolidation:
 * first `{ apply: false }` (dry-run preview rendered in the confirm
 * surface), then `{ apply: true }` once the user confirms. The JSON body
 * is forwarded verbatim; the browser keeps its same-origin fetch pattern
 * (cookie JWT → `Authorization: Bearer`, API base URL stays
 * server-side). Mirrors the sibling GET proxy (`app/api/memory/route.ts`).
 *
 * The active Organization is resolved by the API from the request scope
 * context (the session's last-active Org), not a param — so there is
 * nothing org-specific to forward here.
 */
export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const body = await request.text();
    const upstream = await fetch(`${API_URL}/memory/consolidate`, {
        method: 'POST',
        headers,
        body: body || '{}',
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

    const payload = await upstream.json().catch(() => null);
    return NextResponse.json(
        payload ?? {
            scanned: 0,
            promoted: 0,
            synthesized: 0,
            superseded: 0,
            dryRun: true,
            notes: [],
            details: { promotedIds: [], supersededPairs: [], synthesizedIds: [] },
        },
        { status: 200 },
    );
}

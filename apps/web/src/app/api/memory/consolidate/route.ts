import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

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
 * The active Organization MUST be forwarded as `x-scope-slug`, via
 * `applyBffWorkspaceScope`. This docblock used to claim the opposite — that the
 * API resolves the Org from "the session's last-active Org", so there was
 * "nothing org-specific to forward here". Commit 8f28edca0 (2026-08-23) retired
 * that fallback: `SessionScopeGuard` now seeds `organizationId: null` on an
 * unprefixed request and refuses the user's mutable last-active preference.
 *
 * This one is worse than the sibling GET: consolidation WRITES. Without the
 * header the `{ apply: true }` pass ran in PERSONAL scope, so it could never
 * persist into the Organization the user was looking at — it silently
 * consolidated the wrong workspace.
 */
export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }
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

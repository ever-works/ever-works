import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

/**
 * Org-wide Memory (Cortex P1) — read-only same-origin proxy for the
 * aggregation endpoint (`GET /api/memory`).
 *
 * The Memory page's client shell fetches this route when the user types
 * in the search box or toggles a filter chip, so the browser keeps its
 * same-origin fetch pattern (cookie JWT → `Authorization: Bearer`, API
 * base URL stays server-side). The query string (`?q=&type=&work=…`) is
 * forwarded verbatim. Mirrors the per-Work KB list proxy
 * (`app/api/works/[id]/kb/documents/route.ts`).
 *
 * The active Organization MUST be forwarded as `x-scope-slug`, via
 * `applyBffWorkspaceScope`. This docblock used to claim the opposite — that the
 * API resolves the Org from "the session's last-active Org", so there was
 * "nothing org-specific to forward here". Commit 8f28edca0 (2026-08-23) retired
 * that fallback: `SessionScopeGuard` now seeds `organizationId: null` on an
 * unprefixed request and deliberately refuses to read the user's mutable
 * last-active preference, because two tabs in different Orgs would otherwise
 * race. Org scope arrives ONLY from an `/api/<slug>/…` param or this header.
 *
 * Nothing else supplies it: Next middleware (`proxy.ts`) stamps the browser
 * selector, but its matcher excludes `/api`, so a BFF route never sees it unless
 * the caller sends it — hence `browserApiFetch` on the client side.
 *
 * Until this was fixed, `/org/<slug>/memory` rendered correctly server-side and
 * then emptied on the first keystroke or chip click, because this proxy ran the
 * query in PERSONAL scope.
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, { Accept: 'application/json' });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const search = request.nextUrl.search;
    const upstream = await fetch(`${API_URL}/memory${search}`, {
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
    return NextResponse.json(
        body ?? {
            documents: [],
            counts: { documents: 0, indexed: 0 },
            facets: { types: [], works: [], statuses: [], sources: [] },
        },
        { status: 200 },
    );
}

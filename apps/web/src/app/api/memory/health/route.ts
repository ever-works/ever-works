import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

/**
 * Memory health (memory upgrades M10) — read-only same-origin proxy for
 * `GET /api/memory/health`.
 *
 * The health panel in the KB workbench fetches this CLIENT-side, so the
 * browser keeps its same-origin fetch pattern (cookie JWT →
 * `Authorization: Bearer`, API base URL stays server-side). The query
 * string (`?windowDays=&staleAfterDays=`) is forwarded verbatim.
 *
 * The active Organization is never a param — the API resolves it from the
 * request scope context. That context does NOT arrive on its own, though:
 * this hop is what puts an Organization in it (see EW-786 below). A
 * genuinely org-less session still gets the empty payload (all counts 0,
 * every rate `null`), which the panel renders as "not measurable yet".
 *
 * EW-786 — why that scope context needs help from this hop. It only ever
 * carries an Organization when the request arrived with `x-scope-slug`
 * (or on an `/api/<slug>/…` path): `ScopeResolverMiddleware` runs an
 * unprefixed call under `EMPTY_SCOPE`, and `SessionScopeGuard` then seeds
 * bare personal scope — it deliberately refuses to read the user's stored
 * last-Organization preference, because that is a navigation default and
 * not request authorization. This proxy forwarded no scope header at all,
 * so `OrgMemoryController.getMemoryHealth` took its
 * `organizationId === null` branch on EVERY request from the web app and
 * answered `emptyHealth()` — `MemoryHealthService.getOrgHealth` was
 * unreachable, for personal and Organization sessions alike. The panel
 * has no way to tell that payload apart from a genuinely quiet
 * Organization, so it rendered a measurable-looking wall of zeroes over
 * real retrieval history: precisely the "a number nobody should act on"
 * failure its own `null` handling exists to prevent.
 *
 * Translating the browser's per-tab selector here is what makes the org
 * branch reachable. `KbMemoryHealthPanel` moves to `browserApiFetch` in
 * the same change, so the 400 below is a contract violation by some
 * future caller, never something a reader of the panel can reach.
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const baseHeaders: Record<string, string> = { Accept: 'application/json' };
    if (token) {
        baseHeaders.Authorization = `Bearer ${token}`;
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, baseHeaders);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    const search = request.nextUrl.search;
    const upstream = await fetch(`${API_URL}/memory/health${search}`, {
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
    return NextResponse.json(body, { status: 200 });
}

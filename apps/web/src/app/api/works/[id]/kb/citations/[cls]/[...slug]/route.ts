import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = {
    params: Promise<{ id: string; cls: string; slug: string[] }>;
};

/**
 * EW-641 Phase 2/c row 35c — single-citation resolution proxy for the
 * `<KbCitationHover>` client component.
 *
 * `GET /api/works/:id/kb/citations/:cls/:...slug`
 *   200 → `{ document: KbDocumentBodyDto }` when the citation resolves,
 *   200 → `{ document: null }` when no visible KB doc matches (404 from
 *         upstream is rewritten to a 200+null so the popover can render
 *         a clean "not found" affordance without a fetch error path),
 *   401 → forwards the upstream auth failure verbatim,
 *   5xx → forwards upstream errors verbatim (popover renders error state).
 *
 * Slug resolution order — matches row 35b's `KbMentionResolverService`
 * resolveOne contract so a citation rendered by the LLM resolves the
 * same way as the row 34a `@kb:` user-input mention path:
 *  1. Try `<cls>/<slugSegments>.md` first (canonical stored form for
 *     user-authored docs — the row 17 wikilink picker elides `.md`,
 *     so the LLM is likely to mirror that pattern when citing).
 *  2. If 404, fall back to `<cls>/<slugSegments>` as-is (covers UUIDs +
 *     agent-generated output paths that may not carry `.md`).
 *  3. If both miss → `{ document: null }`.
 *
 * Mirrors `kb/search/route.ts` shape: server-side JWT cookie forward,
 * `cache: 'no-store'`, content-type passthrough for non-success replies.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
    const { id, cls, slug } = await params;

    // Defensive: empty class or empty slug → nothing meaningful to resolve.
    const slugJoined = (slug ?? []).filter((seg) => seg && seg.length > 0).join('/');
    if (!cls || cls.length === 0 || slugJoined.length === 0) {
        return NextResponse.json({ document: null }, { status: 200 });
    }

    const token = await getAuthAccessCookie();
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    // Try canonical `.md` first, then bare `<cls>/<slug>` (row 35b parity).
    const hasExtension = /\.[A-Za-z0-9]+$/.test(slugJoined);
    const attempts = hasExtension
        ? [`${cls}/${slugJoined}`]
        : [`${cls}/${slugJoined}.md`, `${cls}/${slugJoined}`];

    let lastUpstream: Response | null = null;
    for (const path of attempts) {
        const upstream = await fetch(
            `${API_URL}/works/${encodeURIComponent(id)}/kb/documents/${encodeURIComponent(path)}`,
            { method: 'GET', headers, cache: 'no-store' },
        );
        if (upstream.ok) {
            const json = await upstream.json().catch(() => null);
            return NextResponse.json({ document: json ?? null }, { status: 200 });
        }
        lastUpstream = upstream;
        // 404 → keep trying the next path. Any other status (401/403/5xx)
        // is upstream's verdict — surface it immediately rather than
        // firing speculative retries against auth/quota walls.
        if (upstream.status !== 404) break;
    }

    if (lastUpstream && lastUpstream.status === 404) {
        // Distinct from a fetch-error: the proxy successfully reached
        // the API and the citation simply doesn't point at a visible
        // doc. Row 35c's popover surfaces this as `data-status="missing"`.
        return NextResponse.json({ document: null }, { status: 200 });
    }

    if (lastUpstream) {
        const upstreamContentType = lastUpstream.headers.get('content-type') ?? 'application/json';
        const text = await lastUpstream.text().catch(() => '');
        return new Response(text, {
            status: lastUpstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    // Should be unreachable (loop ran at least once) — fall through to
    // a clean "missing" response.
    return NextResponse.json({ document: null }, { status: 200 });
}

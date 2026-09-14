import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 128;
const MAX_TOTAL = 60;
const DEFAULT_PER_KIND = 5;
const MAX_PER_KIND = 25;
const MAX_RECENT = 12;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    if (!raw || !/^\d+$/.test(raw)) return fallback;
    return Math.min(max, Math.max(min, Number(raw)));
}

/**
 * AW-01 — browser-facing proxy for the command palette's workspace search.
 *
 * `GET /api/workspace-search?q=&kinds=&limit=&perKindLimit=&recent=`
 *
 * Wrapped in {@link bffProxy} with the default workspace scope: the palette
 * always runs inside a workspace, so a missing per-tab selector is a bug that
 * must fail closed (400) rather than silently answer from the personal scope.
 * A query under two characters short-circuits to an empty payload without
 * touching the platform. Upstream status codes (including 429) pass through
 * so the palette can tell "throttled" from "no matches".
 */
export const GET = bffProxy(async ({ request, headers }) => {
    const params = request.nextUrl.searchParams;
    const q = (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);

    if (q.length < MIN_QUERY_LENGTH) {
        return NextResponse.json(
            { query: q, groups: [], degradedKinds: [], servedBy: 'fanout', tookMs: 0 },
            { status: 200, headers: { 'Cache-Control': 'no-store' } },
        );
    }

    const upstreamParams = new URLSearchParams();
    upstreamParams.set('q', q);
    upstreamParams.set('limit', String(clampInt(params.get('limit'), MAX_TOTAL, 1, MAX_TOTAL)));
    upstreamParams.set(
        'perKindLimit',
        String(clampInt(params.get('perKindLimit'), DEFAULT_PER_KIND, 1, MAX_PER_KIND)),
    );
    for (const kind of params.getAll('kinds')) {
        if (/^[a-z]{1,32}$/.test(kind)) upstreamParams.append('kinds', kind);
    }
    for (const key of params.getAll('recent').slice(0, MAX_RECENT)) {
        if (/^[a-z]{1,32}:[A-Za-z0-9_-]{1,64}$/.test(key)) upstreamParams.append('recent', key);
    }

    headers.set('Accept', 'application/json');
    const upstream = await fetch(`${API_URL}/workspace-search?${upstreamParams.toString()}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const body = await upstream.text().catch(() => '');
    return new Response(body, {
        status: upstream.status,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    });
});

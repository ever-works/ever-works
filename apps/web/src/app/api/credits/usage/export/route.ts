import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * B29 (account-wide usage CSV export) — Next.js proxy for
 * `GET /api/credits/usage/export`, so the Usage & Credits page can offer
 * a plain download link. Forwards the auth cookie as a Bearer token and
 * PIPES the upstream body through (never `await response.text()`), which
 * keeps the whole period out of this process's memory — the API streams
 * page by page and so does this route.
 *
 * Org scoping is enforced upstream from the request scope context; there
 * is deliberately no org/user parameter to forward.
 *
 * Mirrors apps/web/src/app/api/works/[id]/usage/export/route.ts.
 */

// Security: allowlist of query parameters forwarded to the upstream API.
// Forwarding the raw query string would let a caller inject unknown
// parameters (e.g. a scope override) into the internal API.
const ALLOWED_PARAMS = new Set(['period', 'format']);

// Security: the upstream sets the filename from the resolved period, but
// fall back to a constant if the header is missing — never echo a
// caller-controlled value into a response header.
const FALLBACK_DISPOSITION = 'attachment; filename="usage.csv"';

export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstreamParams = new URLSearchParams();
    request.nextUrl.searchParams.forEach((value, key) => {
        if (ALLOWED_PARAMS.has(key)) {
            upstreamParams.set(key, value);
        }
    });
    const upstreamSearch = upstreamParams.size > 0 ? `?${upstreamParams.toString()}` : '';

    const response = await fetch(`${API_URL}/credits/usage/export${upstreamSearch}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    if (!response.ok || !response.body) {
        return NextResponse.json(
            { error: 'Failed to export usage data' },
            { status: response.status || 500 },
        );
    }

    const upstreamDisposition = response.headers.get('content-disposition');
    const disposition =
        upstreamDisposition && !/[\r\n]/.test(upstreamDisposition)
            ? upstreamDisposition
            : FALLBACK_DISPOSITION;

    return new Response(response.body, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': disposition,
            'Cache-Control': 'no-store',
        },
    });
}

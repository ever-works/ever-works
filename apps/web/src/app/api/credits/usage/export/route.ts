import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScopeFromNavigation } from '@/lib/api/bff-scope';

/**
 * B29 (account-wide usage CSV export) — Next.js proxy for
 * `GET /api/credits/usage/export`, so the Usage & Credits page can offer
 * a plain download link. Forwards the auth cookie as a Bearer token and
 * PIPES the upstream body through (never `await response.text()`), which
 * keeps the whole period out of this process's memory — the API streams
 * page by page and so does this route.
 *
 * **Workspace scope.** This is reached by an `<a href download>`, which
 * cannot carry `x-ever-workspace`, so the selector travels as `?scope=`
 * (`personal` | `org:<slug>`, built with `buildUsageExportQuery`) and is
 * turned into the API's `X-Scope-Slug` here. Upstream, an Organization
 * scope NARROWS the export to that Organization's events; personal — and a
 * link with no selector at all, which is what every bookmark predating the
 * carrier is — exports the caller's own events across every workspace,
 * exactly as before. A present-but-invalid selector is a 400.
 *
 * Mirrors apps/web/src/app/api/works/[id]/usage/export/route.ts.
 */

// Security: allowlist of query parameters forwarded to the upstream API.
// This is also what keeps the `scope` carrier OFF the upstream URL: the
// API's ValidationPipe runs with `forbidNonWhitelisted`, so relaying it
// would be a 400 upstream. The carrier is consumed here.
const ALLOWED_PARAMS = new Set(['period', 'format']);

// Security: the upstream sets the filename from the resolved period, but
// fall back to a constant if the header is missing — never echo a
// caller-controlled value into a response header.
const FALLBACK_DISPOSITION = 'attachment; filename="usage.csv"';

export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    let headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    try {
        headers = applyBffWorkspaceScopeFromNavigation(request, headers);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
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

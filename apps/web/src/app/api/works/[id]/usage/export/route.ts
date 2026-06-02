import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-602 — Next.js proxy for the per-Work usage CSV export.
 * Forwards the auth cookie to the backend as a Bearer token, streams
 * the CSV body back, and re-uses the backend's Content-Disposition
 * filename header so the download lands with a stable name.
 *
 * Mirrors apps/web/src/app/api/activity-log/export/route.ts.
 */
type RouteParams = { params: Promise<{ id: string }> };

// Security: UUID v4 pattern — rejects any id that contains CRLF or other
// special characters before it can reach a header value or upstream URL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Security: allowlist of query parameters forwarded to the upstream API.
// Forwarding the entire raw query string would let callers inject unknown
// parameters that could trigger debug/backdoor behaviour on the backend.
const ALLOWED_PARAMS = new Set(['period', 'granularity']);

export async function GET(request: NextRequest, context: RouteParams) {
    const { id } = await context.params;

    // Security: validate id is a UUID before embedding it in a URL path or
    // HTTP header value. Non-UUID values (including CRLF sequences) get a 400.
    if (!UUID_RE.test(id)) {
        return NextResponse.json({ error: 'Invalid work id' }, { status: 400 });
    }

    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    // Security: reconstruct the query string from an explicit allowlist so
    // unknown/debug parameters are never forwarded to the internal API.
    const upstreamParams = new URLSearchParams();
    request.nextUrl.searchParams.forEach((value, key) => {
        if (ALLOWED_PARAMS.has(key)) {
            upstreamParams.set(key, value);
        }
    });
    const upstreamSearch = upstreamParams.size > 0 ? `?${upstreamParams.toString()}` : '';

    const response = await fetch(`${API_URL}/works/${id}/usage/export${upstreamSearch}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    if (!response.ok) {
        return NextResponse.json(
            { error: 'Failed to export usage data' },
            { status: response.status || 500 },
        );
    }

    const csv = await response.text();
    // Security: sanitize `id` used in the fallback Content-Disposition header
    // to strip any characters that could form a header injection sequence.
    const safeId = id.replace(/[^a-z0-9-]/gi, '_');
    const disposition =
        response.headers.get('content-disposition') ?? `attachment; filename="usage-${safeId}.csv"`;

    return new Response(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': disposition,
        },
    });
}

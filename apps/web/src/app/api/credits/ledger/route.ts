import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Wave 13 (Billing page) — Next.js proxy for the paginated credits
 * ledger, so the client-side table can page/filter without a full
 * navigation. Forwards the auth cookie as a Bearer token.
 *
 * Mirrors apps/web/src/app/api/works/[id]/usage/export/route.ts.
 */

// Security: allowlist of query parameters forwarded to the upstream API.
const ALLOWED_PARAMS = new Set(['period', 'kinds', 'page', 'pageSize']);

export async function GET(request: NextRequest) {
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

    const response = await fetch(`${API_URL}/credits/ledger${upstreamSearch}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
        return NextResponse.json(
            { error: 'Failed to load credits ledger' },
            { status: response.status || 500 },
        );
    }

    return NextResponse.json(body, { status: 200 });
}

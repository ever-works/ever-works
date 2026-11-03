import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { COSTS_SECTIONS, type CostsSection } from '@/lib/api/costs.shared';

/**
 * Costs dashboard — Next.js proxy for the owner-scoped cost
 * aggregations, so the 7/30/90-day window picker can refetch every panel
 * client-side. Forwards the auth cookie as a Bearer token.
 *
 * Mirrors `app/api/credits/usage-summary/route.ts`, with the section as
 * a path segment instead of five near-identical route files.
 */

// Security: the section is interpolated into the upstream URL, so it is
// matched against a closed allow-list rather than sanitized — an unknown
// value is a 404 here and never reaches the internal API.
const ALLOWED_SECTIONS = new Set<string>(COSTS_SECTIONS);

// Security: allowlist of query parameters forwarded upstream, so
// unknown/debug parameters (and anything that looks like a scope
// override) are never passed through.
const ALLOWED_PARAMS = new Set(['windowDays', 'limit']);

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ section: string }> },
) {
    const { section } = await params;
    if (!ALLOWED_SECTIONS.has(section)) {
        return NextResponse.json({ error: 'Unknown costs section' }, { status: 404 });
    }

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

    const response = await fetch(
        `${API_URL}/usage/costs/${section as CostsSection}${upstreamSearch}`,
        { method: 'GET', headers, cache: 'no-store' },
    );

    const body = await response.json().catch(() => null);
    if (!response.ok || !body) {
        return NextResponse.json(
            { error: 'Failed to load costs data' },
            { status: response.status || 500 },
        );
    }

    return NextResponse.json(body, { status: 200 });
}

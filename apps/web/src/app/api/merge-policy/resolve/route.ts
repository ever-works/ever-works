import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Merge-policy matrix (Wave 3, D4) — browser-side proxy for
 * `GET /api/merge-policy/resolve?workId=&agentId=&organizationId=`.
 *
 * The settings cards are client components, so they cannot reach the API
 * host directly (the access token is an httpOnly cookie). This forwards
 * the three scope-checked query params verbatim and lets the upstream
 * controller do the authorization — it 404s Works, Agents and
 * Organizations the caller cannot reach, and that status is passed
 * straight through rather than softened, so the UI never renders a policy
 * for something the user does not own.
 *
 * Only those three params are forwarded. Anything else a caller appends
 * is dropped rather than proxied.
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = new URLSearchParams();
    for (const key of ['workId', 'agentId', 'organizationId'] as const) {
        const value = request.nextUrl.searchParams.get(key);
        if (value) params.set(key, value);
    }
    if ([...params.keys()].length === 0) {
        return NextResponse.json(
            { error: 'Provide workId, agentId and/or organizationId.' },
            { status: 400 },
        );
    }

    const upstream = await fetch(`${API_URL}/merge-policy/resolve?${params.toString()}`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
    });

    const body = await upstream.text().catch(() => '');
    return new Response(body, {
        status: upstream.status,
        headers: {
            'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
            'Cache-Control': 'no-store',
        },
    });
}

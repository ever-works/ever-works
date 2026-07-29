import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Proxy for `GET /api/agent-memory/sessions`.
 *
 * Read-only. The query string (`limit`, `workId`, `projectId`) is
 * forwarded verbatim; the upstream scopes every read to the caller and
 * asserts Work access when `workId` is present, so no authorization
 * decision is made here.
 *
 * Only GET is proxied on purpose. Opening, closing and writing memory
 * belong to agents, not to a browsing user — exposing those verbs from a
 * read surface would let the page mutate an agent's memory as a side
 * effect of being looked at.
 */
export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const upstream = await fetch(`${API_URL}/agent-memory/sessions${request.nextUrl.search}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
    });

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                'Cache-Control': 'no-store',
            },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { sessions: [] }, { status: 200 });
}

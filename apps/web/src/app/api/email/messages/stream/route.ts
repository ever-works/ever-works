import { NextRequest } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-681 / T34 — web BFF proxy for the inbox SSE stream.
 *
 * EventSource can't attach an Authorization header, so the browser
 * connects to this same-origin route (cookies flow), we decrypt the
 * auth token, and pipe the upstream `GET /email/messages/stream`
 * text/event-stream body straight through. The token is never shipped
 * to the browser.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }
    const agentId = request.nextUrl.searchParams.get('agentId') ?? '';
    if (!agentId) {
        return new Response('agentId is required', { status: 400 });
    }

    const upstream = await fetch(
        `${API_URL}/email/messages/stream?agentId=${encodeURIComponent(agentId)}`,
        {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            // @ts-expect-error — Node fetch duplex required when streaming.
            cache: 'no-store',
        },
    );

    if (!upstream.ok || !upstream.body) {
        return new Response('Failed to open inbox stream', { status: upstream.status || 502 });
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        },
    });
}

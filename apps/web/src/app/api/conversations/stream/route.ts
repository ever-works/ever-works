import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScopeFromNavigation } from '@/lib/api/bff-scope';

/**
 * Web BFF proxy for live delivery in the open Conversation — the docked chat
 * panel's `EventSource` connects here.
 *
 * Same shape as the inbox stream proxy (`api/email/messages/stream`): the
 * browser connects same-origin so the auth cookie flows, the token is
 * decrypted here and never shipped to the browser, and the upstream
 * `text/event-stream` body is piped straight through.
 *
 * **Workspace scope.** `EventSource` cannot set request headers, so the
 * per-tab selector travels as `?scope=` (built with `withWorkspaceScopeQuery`)
 * and is turned into the API's `X-Scope-Slug` here, exactly like the other
 * routes a browser reaches without `fetch`. A Conversation in an Organization
 * is only readable in that Organization's scope; without the carrier the
 * stream would 404 for every Organization Conversation. A present-but-invalid
 * selector is a 400. Only `conversationId` is forwarded — the carrier is
 * consumed here, never relayed (the API rejects unknown query parameters).
 *
 * The client falls back to polling on any failure, so every refusal below is
 * a plain status with no body the panel has to read.
 */
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const conversationId = request.nextUrl.searchParams.get('conversationId') ?? '';
    if (!UUID_RE.test(conversationId)) {
        return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScopeFromNavigation(request, {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
        });
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    let upstream: Response;
    try {
        upstream = await fetch(
            `${API_URL}/conversations/stream?conversationId=${encodeURIComponent(conversationId)}`,
            {
                method: 'GET',
                headers,
                cache: 'no-store',
                // Closing the tab (or the panel) closes the upstream stream too,
                // so the API clears its poll and heartbeat timers.
                signal: request.signal,
            },
        );
    } catch {
        return NextResponse.json({ error: 'Failed to open conversation stream' }, { status: 502 });
    }

    if (!upstream.ok || !upstream.body) {
        return NextResponse.json(
            { error: 'Failed to open conversation stream' },
            { status: upstream.status || 502 },
        );
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

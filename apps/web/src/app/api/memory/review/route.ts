import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

/**
 * Proxy for `GET /api/memory/review` — the Memory review queue.
 *
 * Organization documents still marked `reviewState: proposed`, which
 * Memory Consolidation produces and deliberately does not auto-accept.
 * The Organization is resolved server-side from the request scope, so
 * there is no org id for a client to tamper with.
 *
 * EW-786: "the request scope" reaches the API only from `x-scope-slug`
 * (or an `/api/<slug>/…` path), so this hop is where the browser's
 * per-tab `x-ever-workspace` selector has to become that header. Until it
 * did, `listMemoryReviewQueue` found no Organization and returned its
 * empty payload rather than an error — and `MemoryReviewPanel` hides
 * itself on an empty queue, so a backlog of proposed documents was
 * indistinguishable from a clean queue on every `/org/<slug>/memory`
 * visit.
 *
 * That conversion now happens in {@link bffProxy}. The unauthenticated
 * response is overridden to keep this route's PLAIN-TEXT `Unauthorized`
 * rather than the wrapper's JSON default — same bytes as before.
 */
export const GET = bffProxy(
    async ({ request, headers }) => {
        headers.set('Accept', 'application/json');

        const upstream = await fetch(`${API_URL}/memory/review${request.nextUrl.search}`, {
            method: 'GET',
            headers,
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
        return NextResponse.json(body ?? { items: [], total: 0 }, { status: 200 });
    },
    { onUnauthorized: () => new Response('Unauthorized', { status: 401 }) },
);

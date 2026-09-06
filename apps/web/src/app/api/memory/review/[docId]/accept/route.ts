import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy for `POST /api/memory/review/:docId/accept`.
 *
 * Accepting is the moment a machine-written document becomes eligible
 * for context injection, so the upstream re-fetches it scoped to the
 * caller's Organization before writing and answers 404 — not 403 — when
 * it belongs to someone else. Nothing about that decision happens here;
 * this only forwards the caller's bearer and the caller's scope.
 *
 * EW-786: the scope half was missing. `acceptMemoryDocument` reads the
 * Organization off the request scope and refuses with 422 when there is
 * none, so every Accept click from an Organization tab failed — the
 * write path has no empty-payload fallback the way the queue read does.
 *
 * {@link bffProxy} now performs that conversion. The unauthenticated
 * response is overridden to keep this route's PLAIN-TEXT `Unauthorized`
 * rather than the wrapper's JSON default — same bytes as before.
 */
export const POST = bffProxy<RouteContext>(
    async ({ headers }, { params }) => {
        const { docId } = await params;
        headers.set('Accept', 'application/json');

        const upstream = await fetch(
            `${API_URL}/memory/review/${encodeURIComponent(docId)}/accept`,
            {
                method: 'POST',
                headers,
                cache: 'no-store',
            },
        );

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
        return NextResponse.json(body ?? {}, { status: 200 });
    },
    { onUnauthorized: () => new Response('Unauthorized', { status: 401 }) },
);

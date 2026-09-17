import type { NextRequest } from 'next/server';
import { API_URL } from '@/lib/constants';

/**
 * Shared forwarder for the `/api/memory/facts` BFF routes (AW-07).
 *
 * Every route here is wrapped in `bffProxy`, which owns auth and the
 * workspace scope: the browser's per-tab selector becomes `X-Scope-Slug`
 * and a missing selector is a 400, never a silently PERSONAL answer. That
 * matters more for facts than for most surfaces — every fact belongs to one
 * workspace, and an unscoped write would file an Organization's fact under
 * the person's personal workspace. Every handler on
 * `MemoryFactsController` reads the scope context, so there is no unscoped
 * row in this table:
 *
 * | route                                | handler     | scoped |
 * | ------------------------------------ | ----------- | ------ |
 * | `GET  /facts`                        | `list`      | yes    |
 * | `POST /facts`                        | `create`    | yes    |
 * | `GET  /facts/stats`                  | `stats`     | yes    |
 * | `POST /facts/forget-all`             | `forgetAll` | yes    |
 * | `PATCH /facts/:id`                   | `update`    | yes    |
 * | `POST /facts/:id/forget`             | `forget`    | yes    |
 * | `POST /facts/:id/restore`            | `restore`   | yes    |
 * | `POST /facts/:id/accept`             | `accept`    | yes    |
 * | `POST /facts/:id/discard`            | `discard`   | yes    |
 *
 * The upstream status and body are relayed as-is — including 409 / 410 /
 * 422 bodies, whose `message` the UI shows — so no refusal is flattened into
 * a generic error on the way through.
 */
export async function forwardMemoryFacts(
    request: NextRequest,
    headers: Headers,
    upstreamPath: string,
    method: 'GET' | 'POST' | 'PATCH',
): Promise<Response> {
    headers.set('Accept', 'application/json');

    let body: string | undefined;
    if (method !== 'GET') {
        // Buffer rather than stream: these are small JSON bodies and a
        // buffered body keeps the upstream Content-Length honest.
        body = await request.text().catch(() => '');
        if (body) {
            headers.set('Content-Type', 'application/json');
        } else {
            body = undefined;
        }
    }

    const search = method === 'GET' ? request.nextUrl.search : '';
    const upstream = await fetch(`${API_URL}${upstreamPath}${search}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        cache: 'no-store',
    });

    const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
    const contentType = upstream.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);

    // 204 must not carry a body.
    if (upstream.status === 204) {
        return new Response(null, { status: 204, headers: responseHeaders });
    }
    const text = await upstream.text().catch(() => '');
    return new Response(text, { status: upstream.status, headers: responseHeaders });
}

/** Encode a route param for the upstream path. */
export function factPath(id: string, suffix = ''): string {
    return `/memory/facts/${encodeURIComponent(id)}${suffix}`;
}

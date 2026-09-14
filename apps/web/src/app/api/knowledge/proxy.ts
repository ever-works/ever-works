import { API_URL } from '@/lib/constants';
import type { ScopedBffRequest } from '@/lib/api/bff-proxy';

/**
 * Shared upstream relay for the `/api/knowledge` BFF routes.
 *
 * Every route in this family wraps its handler in `bffProxy`, which owns the
 * auth cookie and the workspace scope: `KnowledgeLibraryController` resolves
 * the Organization from the request scope context on EVERY handler (a read
 * with no Organization is an empty shelf, a write is a 404), so each call has
 * to carry the per-tab selector and fails closed with 400 without one. This
 * helper owns only the upstream hop:
 *
 * - the query string is forwarded untouched (`library` filters, `format`);
 * - a JSON body is read once and forwarded as text;
 * - the upstream status and body are relayed as-is, with `Content-Type` and
 *   `Content-Disposition` intact, so a Markdown export downloads with the
 *   slug filename the API chose and an error reaches the panel with the
 *   API's `code` for its copy.
 *
 * | route                                 | upstream                               |
 * | ------------------------------------- | -------------------------------------- |
 * | `GET   /knowledge/library`            | `list`                                 |
 * | `GET   /knowledge/tree`               | `tree`                                 |
 * | `GET   /knowledge/documents/:docId`   | `get`                                  |
 * | `PATCH /knowledge/documents/file`     | `file`                                 |
 * | `POST  /knowledge/documents/:docId/archive`   | `archive`                      |
 * | `POST  /knowledge/documents/:docId/unarchive` | `unarchive`                    |
 * | `GET   /knowledge/documents/:docId/export`    | `export` (Markdown attachment) |
 *
 * Shared-folder writes are not in this family: they stay on the existing
 * folder routes under `/api/memory/files` with the organization scope.
 */
export async function relayKnowledge(
    { request, headers }: ScopedBffRequest,
    upstreamPath: string,
    init: { method: 'GET' | 'POST' | 'PATCH'; withBody?: boolean },
): Promise<Response> {
    headers.set('Accept', request.headers.get('accept') ?? 'application/json');

    let body: string | undefined;
    if (init.withBody) {
        body = await request.text();
        headers.set('Content-Type', request.headers.get('content-type') ?? 'application/json');
    }

    const upstream = await fetch(`${API_URL}${upstreamPath}${request.nextUrl.search}`, {
        method: init.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        cache: 'no-store',
    });

    const responseHeaders = new Headers();
    for (const name of ['content-type', 'content-length', 'content-disposition']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

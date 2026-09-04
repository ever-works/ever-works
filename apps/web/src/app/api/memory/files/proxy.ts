import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

/**
 * Shared same-origin proxy for the /api/memory/files BFF routes.
 *
 * Mirrors the `memory/uploads` proxy: the bearer comes from the auth
 * cookie, the query string is passed through untouched, and multipart
 * bodies are STREAMED upstream (duplex half) so the boundary survives
 * for NestJS's FileInterceptor. Responses are relayed as-is — including
 * binary downloads — rather than re-parsed, so Content-Type /
 * Content-Disposition from the API reach the browser intact.
 *
 * **Workspace scope (EW-786).** `scoped` is REQUIRED, and deliberately
 * has no default: the routes fanning through this one function do not
 * agree on whether the Organization matters, so every call site has to
 * make that call explicitly rather than inherit a silent default.
 *
 * `scoped: true` converts the browser's per-tab `x-ever-workspace`
 * selector into the API's `X-Scope-Slug` contract and overwrites any
 * client-supplied value; a missing or stale selector is a 400 here
 * instead of a personal-scoped answer. A `scoped: true` route can
 * therefore only be reached through `browserApiFetch`.
 *
 * The current table, checked against `MemoryFilesController`:
 *
 * | route                              | handler       | org-aware | scoped |
 * | ---------------------------------- | ------------- | --------- | ------ |
 * | `GET  /files`                       | `list`        | yes       | yes    |
 * | `PATCH /files/move`                 | `moveFiles`   | yes       | yes    |
 * | `POST /files/folders/:id/sync`      | `syncFolder`  | yes       | yes    |
 * | `GET  /files/tree`                  | `getTree`     | no        | no     |
 * | `POST /files/upload`                | `upload`      | no        | no     |
 * | `POST /files/folders`               | `createFolder`| no        | no     |
 * | `PATCH|DELETE /files/folders/:id`   | `update|delete` | no      | no     |
 * | `GET  /files/:id/download`          | `download`    | yes       | NO — see that route |
 *
 * The four `no`-org handlers key off `auth.userId` (and, for folders,
 * `MemoryFoldersService` ownership) and never touch
 * `ScopeContextService`, so scoping them would buy nothing and would
 * newly 400 a request that works today. Download is the exception that
 * needs its own paragraph — it is org-aware but unreachable by
 * `browserApiFetch`; the reasoning lives in `[id]/download/route.ts`.
 */
export async function proxyMemoryFiles(
    request: NextRequest,
    upstreamPath: string,
    init: { method: string; body?: BodyInit | null; scoped: boolean },
): Promise<Response> {
    const token = await getAuthAccessCookie();

    const baseHeaders = new Headers();
    baseHeaders.set('Accept', request.headers.get('accept') ?? 'application/json');
    const contentType = request.headers.get('content-type');
    if (contentType && init.body !== undefined) {
        baseHeaders.set('Content-Type', contentType);
    }
    if (token) {
        baseHeaders.set('Authorization', `Bearer ${token}`);
    }

    let headers = baseHeaders;
    if (init.scoped) {
        try {
            headers = applyBffWorkspaceScope(request, baseHeaders);
        } catch {
            return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
        }
    }

    const upstream = await fetch(`${API_URL}${upstreamPath}${request.nextUrl.search}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body, duplex: 'half' } : {}),
        cache: 'no-store',
    } as RequestInit & { duplex?: 'half' });

    const responseHeaders = new Headers();
    for (const name of ['content-type', 'content-length', 'content-disposition']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

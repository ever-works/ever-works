import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET as listFiles } from './route';
import { GET as getTree } from './tree/route';
import { POST as uploadFile } from './upload/route';
import { PATCH as moveFiles } from './move/route';
import { POST as createFolder } from './folders/route';
import { PATCH as updateFolder, DELETE as deleteFolder } from './folders/[id]/route';
import { POST as syncFolder } from './folders/[id]/sync/route';
import { GET as downloadFile } from './[id]/download/route';

/**
 * Build a request for the shared `/api/memory/files` proxy.
 *
 * `x-scope-slug` is pre-set on EVERY request so each case also proves the
 * BFF never relays a browser-chosen Organization: a scoped route must
 * overwrite it, an unscoped route must drop it.
 */
function request(
    path: string,
    { method = 'GET', selector, body }: { method?: string; selector?: string; body?: string } = {},
): NextRequest {
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest(`http://web.example${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
    });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function forwarded(fetchMock: ReturnType<typeof vi.fn>, call = 0): Headers {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return new Headers(init.headers);
}

/**
 * EW-786 — the `/api/memory/files` half of the BFF scope contract.
 *
 * Since `8f28edca0` an Organization reaches the API only through
 * `X-Scope-Slug`; the whole Files area forwarded nothing, so it ran in
 * personal scope and the org's Memory originals were invisible at HTTP 200.
 *
 * These routes all fan through one `proxyMemoryFiles`, but they do NOT all
 * want scoping, so the spec pins the routing table itself — which handlers
 * are org-aware (`MemoryFilesController` reading `ScopeContextService`) and
 * which are per-user — as much as it pins the mechanics. Scoping a route
 * whose handler ignores the org would only buy a new 400.
 */
describe('/api/memory/files workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    describe('scoped — the handler reads ScopeContextService', () => {
        it('GET /files forwards the per-tab selector as the API scope header', async () => {
            const response = await listFiles(
                request('/api/memory/files?folderId=fold-1', { selector: 'org:ever' }),
            );

            expect(response.status).toBe(200);
            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toBe('http://api.example/memory/files?folderId=fold-1');
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('ever');
            // The browser-side selector is an internal transport detail and
            // must not leak upstream, and the client's own `x-scope-slug`
            // guess must not survive.
            expect(forwarded(fetchMock).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
            expect(forwarded(fetchMock).get('Authorization')).toBe('Bearer fake-jwt');
        });

        it('GET /files maps the personal selector to the personal sentinel', async () => {
            await listFiles(request('/api/memory/files', { selector: 'personal' }));

            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('@personal');
        });

        it('PATCH /files/move forwards the selector and still streams the body', async () => {
            const req = request('/api/memory/files/move', {
                method: 'PATCH',
                selector: 'org:ever',
                body: JSON.stringify({ files: [{ source: 'upload', id: 'up-1' }], folderId: null }),
            });

            const response = await moveFiles(req);

            expect(response.status).toBe(200);
            const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('http://api.example/memory/files/move');
            expect(init.body).not.toBeUndefined();
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('ever');
            expect(forwarded(fetchMock).get('Content-Type')).toBe('application/json');
        });

        it('POST /files/folders/:id/sync forwards the selector', async () => {
            await syncFolder(
                request('/api/memory/files/folders/fold-1/sync', {
                    method: 'POST',
                    selector: 'org:ever',
                }),
                params('fold-1'),
            );

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toBe('http://api.example/memory/files/folders/fold-1/sync');
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('ever');
        });

        it.each([
            ['GET /files', () => listFiles(request('/api/memory/files'))],
            [
                'PATCH /files/move',
                () => moveFiles(request('/api/memory/files/move', { method: 'PATCH', body: '{}' })),
            ],
            [
                'POST /files/folders/:id/sync',
                () =>
                    syncFolder(
                        request('/api/memory/files/folders/fold-1/sync', { method: 'POST' }),
                        params('fold-1'),
                    ),
            ],
        ])('%s fails closed before upstream without a selector', async (_label, call) => {
            const response = await call();

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('GET /files fails closed on a malformed selector', async () => {
            const response = await listFiles(
                request('/api/memory/files', { selector: 'org:Not A Slug' }),
            );

            expect(response.status).toBe(400);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    /**
     * These four handlers key off `auth.userId` alone — `getTree`,
     * `upload`, `createFolder`, `updateFolder`/`deleteFolder` never touch
     * `ScopeContextService`. `memory_folders` is one per-user tree shared
     * by every workspace, and an upload lands in the caller's own
     * `user_uploads` spine. Scoping them would forward a header nobody
     * reads and would newly 400 requests that are correct today, so the
     * spec pins them as unscoped-on-purpose rather than as an oversight.
     */
    describe('unscoped — the handler is per-user', () => {
        it.each([
            ['GET /files/tree', () => getTree(request('/api/memory/files/tree'))],
            [
                'POST /files/upload',
                () => uploadFile(request('/api/memory/files/upload', { method: 'POST' })),
            ],
            [
                'POST /files/folders',
                () => createFolder(request('/api/memory/files/folders', { method: 'POST' })),
            ],
            [
                'PATCH /files/folders/:id',
                () =>
                    updateFolder(
                        request('/api/memory/files/folders/fold-1', { method: 'PATCH' }),
                        params('fold-1'),
                    ),
            ],
            [
                'DELETE /files/folders/:id',
                () =>
                    deleteFolder(
                        request('/api/memory/files/folders/fold-1', { method: 'DELETE' }),
                        params('fold-1'),
                    ),
            ],
        ])('%s reaches upstream without a selector and sends no scope', async (_label, call) => {
            const response = await call();

            expect(response.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // Not merely "absent": the incoming request DID carry an
            // `x-scope-slug`, and the proxy must not relay a browser's.
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBeNull();
            expect(forwarded(fetchMock).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        });
    });

    /**
     * Download is reached by document requests — the `<a href>` in
     * `MemoryFilesPanel`, the same anchor in `MemoryFilePreview`, the KB
     * binary viewers' `<img>`/`<video>` sources — which cannot carry a
     * header, so it takes the selector from the `?scope=` carrier instead.
     * The full contract lives in `[id]/download/route.unit.spec.ts`; pinned
     * here from the family's point of view: a link with no carrier still
     * serves (personal), and the carrier never reaches the API's query.
     */
    describe('download — the query carrier', () => {
        it('GET /files/:id/download serves a link with no selector in personal scope', async () => {
            const response = await downloadFile(
                request('/api/memory/files/kb-9/download?source=kb-upload'),
                params('kb-9'),
            );

            expect(response.status).toBe(200);
            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toBe('http://api.example/memory/files/kb-9/download?source=kb-upload');
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('@personal');
        });

        it('GET /files/:id/download reads ?scope= and strips it from the upstream query', async () => {
            await downloadFile(
                request('/api/memory/files/kb-9/download?source=kb-upload&scope=org:ever'),
                params('kb-9'),
            );

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toBe('http://api.example/memory/files/kb-9/download?source=kb-upload');
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('ever');
        });
    });
});

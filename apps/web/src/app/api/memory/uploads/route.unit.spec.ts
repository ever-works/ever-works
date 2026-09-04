import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET, POST } from './route';

function listRequest(selector?: string): NextRequest {
    // Pre-set so the spec proves the BFF overwrites the API contract header
    // rather than letting a browser choose the Organization it reads.
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/memory/uploads?limit=50', { headers });
}

function uploadRequest(selector?: string): NextRequest {
    const headers = new Headers({
        'content-type': 'multipart/form-data; boundary=----spec',
        [API_SCOPE_HEADER]: 'attacker-supplied-org',
    });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/memory/uploads', {
        method: 'POST',
        headers,
        body: '------spec\r\n\r\n------spec--\r\n',
    });
}

function forwarded(fetchMock: ReturnType<typeof vi.fn>): Headers {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return new Headers(init.headers);
}

/**
 * EW-786 — the global-Memory Originals half of the BFF scope contract.
 *
 * Both handlers on `OrgMemoryController` resolve the Organization from
 * `ScopeContextService`, and both fail SOFTLY without one:
 * `listMemoryUploads` returns `{ items: [], total: 0 }` at HTTP 200 and
 * `createMemoryUpload` throws 422 ("no active Organization"). Since
 * `8f28edca0` this proxy forwarded no scope at all, so the panel showed an
 * empty Originals list for a populated org and blamed the user's org setup
 * for every upload it had itself scoped away.
 *
 * These pin both halves: the per-tab `x-ever-workspace` selector becomes
 * `X-Scope-Slug`, and its absence is a 400 BEFORE the upstream call — never
 * a personal-scoped empty list or a misleading 422.
 */
describe('/api/memory/uploads workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ items: [{ id: 'up-1' }], total: 1 }), {
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

    describe('GET — list originals', () => {
        it('forwards the per-tab selector as the API scope header', async () => {
            const response = await GET(listRequest('org:ever'));

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ total: 1 });

            const [url] = fetchMock.mock.calls[0] as [string];
            expect(url).toBe('http://api.example/memory/uploads?limit=50');
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('ever');
            expect(forwarded(fetchMock).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
            expect(forwarded(fetchMock).get('Authorization')).toBe('Bearer fake-jwt');
        });

        it('maps the personal selector to the personal sentinel', async () => {
            await GET(listRequest('personal'));

            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('@personal');
        });

        it('fails closed before upstream when the selector is absent', async () => {
            const response = await GET(listRequest());

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('fails closed on a malformed selector', async () => {
            const response = await GET(listRequest('org:Not A Slug'));

            expect(response.status).toBe(400);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('POST — upload an original', () => {
        it('forwards the selector and keeps the multipart content type intact', async () => {
            const response = await POST(uploadRequest('org:ever'));

            expect(response.status).toBe(200);
            const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('http://api.example/memory/uploads');
            // The body is streamed, not re-parsed — the boundary has to
            // survive for NestJS's FileInterceptor.
            expect(init.body).not.toBeUndefined();
            expect(forwarded(fetchMock).get(API_SCOPE_HEADER)).toBe('ever');
            expect(forwarded(fetchMock).get('Content-Type')).toBe(
                'multipart/form-data; boundary=----spec',
            );
        });

        it('fails closed before writing anything when the selector is absent', async () => {
            const response = await POST(uploadRequest());

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });
});

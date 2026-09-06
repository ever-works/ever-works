import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

/**
 * Org-scoped Memory originals were listed by the (scoped) Files table and then
 * 404'd on download, because this route was reached by document navigation
 * and forwarded no scope. The selector now rides on `?scope=`. These drive the
 * real route so they fail if `proxyMemoryFiles` stops reading the carrier.
 */
function request(query: string, opts: { selector?: string; referer?: string } = {}) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (opts.selector) headers.set('x-ever-workspace', opts.selector);
    if (opts.referer) headers.set('referer', opts.referer);
    return new NextRequest(`http://web.example/api/memory/files/up-1/download${query}`, {
        headers,
    });
}

const ctx = { params: Promise.resolve({ id: 'up-1' }) };

describe('GET /api/memory/files/[id]/download — workspace scope carrier', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () =>
                new Response('bytes', {
                    status: 200,
                    headers: { 'content-type': 'application/octet-stream' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        delete process.env.WEB_URL;
    });

    function upstream() {
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        return { url, headers: new Headers(init.headers) };
    }

    it('reads ?scope= and forwards it as x-scope-slug, stripping the carrier from the upstream query', async () => {
        const response = await GET(request('?source=upload&scope=org:ever'), ctx);

        expect(response.status).toBe(200);
        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/memory/files/up-1/download?source=upload');
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('runs personal when no selector is present — a link predating the carrier keeps working', async () => {
        await GET(request('?source=upload'), ctx);

        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/memory/files/up-1/download?source=upload');
        expect(headers.get('x-scope-slug')).toBe('@personal');
    });

    it('falls back to the x-ever-workspace header for fetch callers', async () => {
        await GET(request('?source=kb-upload', { selector: 'org:ever' }), ctx);

        expect(upstream().headers.get('x-scope-slug')).toBe('ever');
    });

    it('rejects a present-but-invalid ?scope= with 400 and never reaches the API', async () => {
        const response = await GET(request('?source=upload&scope=nope'), ctx);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a ?scope= that disagrees with the page it was clicked from', async () => {
        const response = await GET(
            request('?source=upload&scope=org:ever', {
                referer: 'http://web.example/org/yo/memory',
            }),
            ctx,
        );

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

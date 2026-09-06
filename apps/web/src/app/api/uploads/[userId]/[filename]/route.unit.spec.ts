import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

/**
 * The serve proxy is reached by `<img src>` and `<a href>` on API-minted
 * URLs, so it can only ever see a selector in `?scope=`. The server side is
 * safe to ship alone: with no carrier it runs personal, byte-identical to
 * before. These drive the real route so they fail if it stops reading the
 * carrier or starts relaying it upstream.
 */
function request(query = '', opts: { selector?: string; referer?: string } = {}) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (opts.selector) headers.set('x-ever-workspace', opts.selector);
    if (opts.referer) headers.set('referer', opts.referer);
    return new NextRequest(`http://web.example/api/uploads/u1/abc.png${query}`, { headers });
}

const ctx = { params: Promise.resolve({ userId: 'u1', filename: 'abc.png' }) };

describe('GET /api/uploads/[userId]/[filename] — workspace scope carrier', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () =>
                new Response('bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
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

    it('reads ?scope= and forwards it as x-scope-slug, keeping the carrier OFF the upstream URL', async () => {
        const response = await GET(request('?scope=org:ever&workId=w-1'), ctx);

        expect(response.status).toBe(200);
        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/uploads/u1/abc.png?workId=w-1');
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('runs personal when no selector is present — every API-minted URL in chat history keeps working', async () => {
        await GET(request(), ctx);

        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/uploads/u1/abc.png');
        expect(headers.get('x-scope-slug')).toBe('@personal');
    });

    it('rejects a present-but-invalid ?scope= with 400 and never reaches the API', async () => {
        const response = await GET(request('?scope=bad'), ctx);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 401 for a missing cookie BEFORE looking at the scope', async () => {
        vi.mocked(getAuthAccessCookie).mockResolvedValueOnce(undefined);

        const response = await GET(request('?scope=bad'), ctx);

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

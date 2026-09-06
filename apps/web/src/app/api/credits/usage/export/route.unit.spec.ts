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
 * `<a href download>` cannot carry a header, so this route reads the selector
 * from `?scope=`. Before the carrier the usage CSV ALWAYS ran personal: a
 * member standing in `/org/<slug>/settings` exported their own events across
 * every workspace, and the Organization they were looking at made no
 * difference. These drive the real route so they fail if it stops calling
 * `applyBffWorkspaceScopeFromNavigation`.
 */
function request(query = '', opts: { selector?: string; referer?: string } = {}) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (opts.selector) headers.set('x-ever-workspace', opts.selector);
    if (opts.referer) headers.set('referer', opts.referer);
    return new NextRequest(`http://web.example/api/credits/usage/export${query}`, { headers });
}

describe('GET /api/credits/usage/export — workspace scope carrier', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () =>
                new Response('a,b\n', {
                    status: 200,
                    headers: { 'content-disposition': 'attachment; filename="usage-2026-08.csv"' },
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

    it('reads ?scope= and forwards it as x-scope-slug, keeping the carrier OFF the upstream query', async () => {
        const response = await GET(request('?period=2026-08&scope=org:ever'));

        expect(response.status).toBe(200);
        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/credits/usage/export?period=2026-08');
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('runs personal when no selector is present — an old bookmark keeps working', async () => {
        const response = await GET(request('?period=2026-08'));

        expect(response.status).toBe(200);
        expect(upstream().headers.get('x-scope-slug')).toBe('@personal');
    });

    it('falls back to the x-ever-workspace header for fetch callers', async () => {
        await GET(request('', { selector: 'org:ever' }));

        expect(upstream().headers.get('x-scope-slug')).toBe('ever');
    });

    it('rejects a present-but-invalid ?scope= with 400 and never reaches the API', async () => {
        const response = await GET(request('?scope=garbage'));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a ?scope= that disagrees with the page it was clicked from', async () => {
        const response = await GET(
            request('?scope=org:ever', { referer: 'http://web.example/org/yo/settings/usage' }),
        );

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

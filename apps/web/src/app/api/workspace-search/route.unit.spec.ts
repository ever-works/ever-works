import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cookie = vi.hoisted(() => ({ token: 'fake-jwt' as string | null }));

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => cookie.token),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example/api',
}));

import { GET } from './route';

function request(query: string, selector: string | null = 'personal') {
    const headers = new Headers();
    if (selector) headers.set('x-ever-workspace', selector);
    return new NextRequest(`http://web.example/api/workspace-search?${query}`, { headers });
}

describe('GET /api/workspace-search (BFF)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        cookie.token = 'fake-jwt';
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ query: 'inv', groups: [], degradedKinds: [] }), {
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

    it('forwards the per-tab Organization selector as the platform scope header', async () => {
        const response = await GET(request('q=invoice', 'org:ever'));
        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url.startsWith('http://api.example/api/workspace-search?')).toBe(true);
        const headers = new Headers(init.headers);
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('authorization')).toBe('Bearer fake-jwt');
        expect(init.cache).toBe('no-store');
    });

    it('fails closed with 400 when the workspace selector is missing', async () => {
        const response = await GET(request('q=invoice', null));
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 401 without an auth cookie', async () => {
        cookie.token = null;
        const response = await GET(request('q=invoice'));
        expect(response.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('short-circuits a query under two characters without calling the platform', async () => {
        const response = await GET(request('q=%20a%20'));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            query: 'a',
            groups: [],
            degradedKinds: [],
            servedBy: 'fanout',
            tookMs: 0,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('clamps limits and drops malformed kinds and recent keys', async () => {
        await GET(
            request(
                'q=invoice&limit=500&perKindLimit=99&kinds=task&kinds=DROP%20TABLE&recent=task:t1&recent=bad%20key',
            ),
        );
        const url = new URL(fetchMock.mock.calls[0][0] as string);
        expect(url.searchParams.get('limit')).toBe('60');
        expect(url.searchParams.get('perKindLimit')).toBe('25');
        expect(url.searchParams.getAll('kinds')).toEqual(['task']);
        expect(url.searchParams.getAll('recent')).toEqual(['task:t1']);
    });

    it('passes an upstream throttle response through unchanged', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response('{"message":"Too Many Requests"}', {
                status: 429,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const response = await GET(request('q=invoice'));
        expect(response.status).toBe(429);
        await expect(response.text()).resolves.toContain('Too Many Requests');
    });
});

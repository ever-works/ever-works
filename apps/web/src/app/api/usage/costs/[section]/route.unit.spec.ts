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
 * The Costs proxy interpolates `[section]` into the upstream URL, so the
 * section is matched against a closed allow-list and every query parameter
 * against another. AW-17 adds three sections (`by-tool`, `by-mission`,
 * `by-meter`) and one parameter (`full`); nothing else about the route moves.
 */
function call(section: string, query = '') {
    const request = new NextRequest(`http://web.example/api/usage/costs/${section}${query}`);
    return GET(request, { params: Promise.resolve({ section }) });
}

describe('GET /api/usage/costs/[section]', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ status: 'success', rows: [] }), {
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

    it.each(['by-tool', 'by-mission', 'by-meter'])(
        'forwards the %s section upstream',
        async (section) => {
            const response = await call(section, '?windowDays=30');

            expect(response.status).toBe(200);
            const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
            expect(url).toBe(`http://api.example/usage/costs/${section}?windowDays=30`);
            expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-jwt');
        },
    );

    it('keeps forwarding the pre-existing sections', async () => {
        for (const section of ['summary', 'daily', 'by-agent', 'by-model', 'top-runs']) {
            const response = await call(section);
            expect(response.status).toBe(200);
        }
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('404s an unknown section before reaching the API', async () => {
        const response = await call('by-secret');

        expect(response.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards only allow-listed parameters — full is allowed, a scope override is not', async () => {
        await call('by-mission', '?windowDays=90&full=true&userId=someone-else&limit=5');

        const [url] = fetchMock.mock.calls[0] as [string];
        const upstream = new URL(url);
        expect(upstream.searchParams.get('full')).toBe('true');
        expect(upstream.searchParams.get('windowDays')).toBe('90');
        expect(upstream.searchParams.get('limit')).toBe('5');
        expect(upstream.searchParams.has('userId')).toBe(false);
    });
});

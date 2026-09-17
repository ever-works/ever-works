import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { GET } from './route';

function request(query: string, selector?: string) {
    // A client-supplied API scope header must never survive the hop.
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest(`http://web.example/api/knowledge/library${query}`, { headers });
}

/**
 * The shelf is read for the Organization in the request scope, so this hop
 * is where the per-tab selector becomes the API scope header. Without it the
 * API would answer an empty shelf with HTTP 200 and the documents would look
 * like they had vanished.
 */
describe('GET /api/knowledge/library', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ documents: [], nextCursor: null, total: 0, unreadCount: 0 }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('forwards the filters untouched with the per-tab Organization scope', async () => {
        const response = await GET(
            request('?folderId=unfiled&q=refund&class=style&class=brand&sort=title', 'org:ever'),
        );

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            'http://api.example/knowledge/library?folderId=unfiled&q=refund&class=style&class=brand&sort=title',
        );
        const headers = new Headers(init.headers);
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('fails closed before upstream when the selector is absent', async () => {
        const response = await GET(request(''));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 401 without an auth cookie and never reaches the API', async () => {
        vi.mocked(getAuthAccessCookie).mockResolvedValueOnce(undefined as never);

        const response = await GET(request('', 'org:ever'));

        expect(response.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('relays an upstream validation error with its status and body', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ message: ['limit must not be greater than 200'] }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const response = await GET(request('?limit=201', 'org:ever'));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            message: ['limit must not be greater than 200'],
        });
    });
});

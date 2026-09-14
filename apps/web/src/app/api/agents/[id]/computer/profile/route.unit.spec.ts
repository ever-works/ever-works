import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

const AGENT = '11111111-2222-4333-8444-555555555555';
const NODE = '22222222-2222-4333-8444-555555555555';

function request(query: string, selector = 'org:ever'): NextRequest {
    return new NextRequest(`http://web.example/api/agents/${AGENT}/computer/profile${query}`, {
        method: 'GET',
        headers: new Headers({ [BROWSER_WORKSPACE_SCOPE_HEADER]: selector }),
    });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** The profile read the panel uses for a computer the page did not server-render. */
describe('GET /api/agents/:id/computer/profile', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ reason: 'profile-not-found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('forwards the one computer’s profile read with the workspace scope, and passes the status through', async () => {
        const response = await GET(request(`?nodeId=${NODE}`), params(AGENT));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`http://api.example/agents/${AGENT}/computer/profile?nodeId=${NODE}`);
        expect(init.method).toBe('GET');
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('ever');
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ reason: 'profile-not-found' });
    });

    it('checks both ids before anything leaves the web tier', async () => {
        expect((await GET(request(`?nodeId=${NODE}`), params('not-a-uuid'))).status).toBe(400);
        expect((await GET(request('?nodeId=../../x'), params(AGENT))).status).toBe(400);
        expect((await GET(request(''), params(AGENT))).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

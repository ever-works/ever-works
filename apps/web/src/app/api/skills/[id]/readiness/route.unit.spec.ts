import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET, POST } from './route';
import { POST as ENABLE } from '../enable/route';
import { POST as DISABLE } from '../disable/route';

/**
 * Skills shelf BFF proxies — the card toggle and Re-check. They carry the
 * session bearer and the workspace scope (via `bffProxy`), refuse a malformed
 * id before any upstream call, and pass the upstream status through, so a 404
 * for another workspace's Skill reaches the card as a 404.
 */
const ID = '11111111-1111-4111-8111-111111111111';

function request(method: 'GET' | 'POST', selector: string | null = 'personal') {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied' });
    if (selector) headers.set('x-ever-workspace', selector);
    return new NextRequest(`http://web.example/api/skills/${ID}/readiness`, { method, headers });
}

const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

describe('Skills shelf BFF routes', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: ID, cardState: 'ready' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        delete process.env.WEB_URL;
    });

    it.each([
        ['GET readiness', () => GET(request('GET'), ctx()), 'GET', `/skills/${ID}/readiness`],
        [
            'POST readiness (refresh)',
            () => POST(request('POST'), ctx()),
            'POST',
            `/skills/${ID}/readiness/refresh`,
        ],
        ['POST enable', () => ENABLE(request('POST'), ctx()), 'POST', `/skills/${ID}/enable`],
        ['POST disable', () => DISABLE(request('POST'), ctx()), 'POST', `/skills/${ID}/disable`],
    ])('%s forwards to the API with the bearer', async (_label, call, method, path) => {
        const response = await call();
        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`http://api.example${path}`);
        expect(init.method).toBe(method);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fake-jwt');
    });

    it('passes a 404 through unchanged', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Skill not found.' }), { status: 404 }),
        );
        const response = await DISABLE(request('POST'), ctx());
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ message: 'Skill not found.' });
    });

    it('refuses a malformed id without calling the API', async () => {
        const response = await ENABLE(request('POST'), ctx('not-a-uuid'));
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses without a session cookie', async () => {
        vi.mocked(getAuthAccessCookie).mockResolvedValueOnce(undefined as never);
        const response = await GET(request('GET'), ctx());
        expect(response.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed without the workspace selector', async () => {
        const response = await POST(request('POST', null), ctx());
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

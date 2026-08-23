import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

function request(selector?: string) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (selector) headers.set('x-ever-workspace', selector);
    return new Request('http://web.example/api/organizations', { headers }) as Parameters<
        typeof GET
    >[0];
}

describe('GET /api/organizations workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify([]), {
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

    it('overwrites spoofing and forwards the explicit per-tab Organization selector', async () => {
        const response = await GET(request('org:ever'));

        expect(response.status).toBe(200);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('ever');
        expect(new Headers(init.headers).get('x-ever-workspace')).toBeNull();
    });

    it('fails closed before upstream when the browser selector is absent', async () => {
        const response = await GET(request());

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

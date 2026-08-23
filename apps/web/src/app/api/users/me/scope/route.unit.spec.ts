import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { GET, POST } from './route';

function makeRequest(body?: string, selector: string | null = 'personal', referer?: string) {
    const headers = new Headers(
        body === undefined ? undefined : { 'content-type': 'application/json' },
    );
    if (selector !== null) headers.set('x-ever-workspace', selector);
    if (referer) headers.set('referer', referer);
    headers.set('x-scope-slug', 'attacker-supplied');
    return new Request('http://web.example/api/users/me/scope', {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body,
    }) as Parameters<typeof POST>[0];
}

describe('/api/users/me/scope BFF', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.mocked(getAuthAccessCookie).mockResolvedValue('access-token');
        fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    tenantId: 'tenant-1',
                    organizationId: 'org-ever',
                    organizationSlug: 'ever',
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('GET forwards the encrypted-cookie token only as a bearer header', async () => {
        const response = await GET(makeRequest());

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ organizationSlug: 'ever' });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/users/me/scope');
        expect(init.method).toBe('GET');
        expect((init.headers as Headers).get('authorization')).toBe('Bearer access-token');
        expect((init.headers as Headers).get('x-scope-slug')).toBe('@personal');
        expect((init.headers as Headers).get('x-ever-workspace')).toBeNull();
    });

    it('POST forwards the selection and returns the persisted active scope', async () => {
        const response = await POST(makeRequest(JSON.stringify({ organizationSlug: 'ever' })));

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/users/me/scope');
        expect(init.method).toBe('POST');
        expect(init.body).toBe(JSON.stringify({ organizationSlug: 'ever' }));
        expect((init.headers as Headers).get('authorization')).toBe('Bearer access-token');
    });

    it('passes an upstream rejection through without changing its status or body', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ message: "Organization 'foreign' not found" }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const response = await POST(makeRequest(JSON.stringify({ organizationSlug: 'foreign' })));

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
            message: "Organization 'foreign' not found",
        });
    });

    it('accepts an explicit Organization selector without Referer and overwrites spoofing', async () => {
        const response = await POST(
            makeRequest(JSON.stringify({ organizationSlug: 'ever' }), 'org:ever'),
        );

        expect(response.status).toBe(200);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect((init.headers as Headers).get('x-scope-slug')).toBe('ever');
    });

    it('fails closed on a missing or stale browser selector', async () => {
        const missing = await POST(makeRequest('{}', null));
        expect(missing.status).toBe(400);

        const stale = await POST(
            makeRequest('{}', 'org:ever', 'http://web.example/org/yo/dashboard'),
        );
        expect(stale.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 401 without making an upstream request when the auth cookie is absent', async () => {
        vi.mocked(getAuthAccessCookie).mockResolvedValueOnce(undefined);

        const response = await GET(makeRequest());

        expect(response.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects invalid JSON locally without making an upstream request', async () => {
        const response = await POST(makeRequest('{'));

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

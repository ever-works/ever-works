import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { POST } from './route';

const ctx = { params: Promise.resolve({ docId: 'doc-1' }) };

function request(selector?: string) {
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/knowledge/documents/doc-1/archive', {
        method: 'POST',
        headers,
    });
}

describe('POST /api/knowledge/documents/[docId]/archive', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: 'doc-1', status: 'archived' }), {
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

    it('posts upstream with the per-tab Organization scope and no body', async () => {
        const response = await POST(request('org:ever'), ctx);

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/knowledge/documents/doc-1/archive');
        expect(init.method).toBe('POST');
        expect(init.body).toBeUndefined();
        const headers = new Headers(init.headers);
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('relays a 403 for a member without edit access', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ status: 'error', message: 'Forbidden' }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const response = await POST(request('org:ever'), ctx);

        expect(response.status).toBe(403);
    });

    it('fails closed before upstream when the selector is absent', async () => {
        const response = await POST(request(), ctx);

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

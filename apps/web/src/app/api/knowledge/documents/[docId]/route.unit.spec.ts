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

const ctx = (docId: string) => ({ params: Promise.resolve({ docId }) });

function request(selector?: string) {
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-org' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/knowledge/documents/doc-1', { headers });
}

describe('GET /api/knowledge/documents/[docId]', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: 'doc-1', folderPath: '/Playbooks' }), {
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

    it('reads one shelf row for the per-tab Organization, encoding the id', async () => {
        const response = await GET(request('org:ever'), ctx('doc 1/../x'));

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/knowledge/documents/doc%201%2F..%2Fx');
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('ever');
    });

    it('relays a 404 for a document outside the Organization', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ status: 'error', message: 'Document not found' }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const response = await GET(request('personal'), ctx('doc-1'));

        expect(response.status).toBe(404);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('@personal');
    });

    it('fails closed before upstream when the selector is absent', async () => {
        const response = await GET(request(), ctx('doc-1'));

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

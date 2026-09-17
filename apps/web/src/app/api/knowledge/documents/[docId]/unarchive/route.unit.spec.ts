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
    return new NextRequest('http://web.example/api/knowledge/documents/doc-1/unarchive', {
        method: 'POST',
        headers,
    });
}

describe('POST /api/knowledge/documents/[docId]/unarchive', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ document: { id: 'doc-1' }, restoredToUnfiled: true }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('posts upstream with the per-tab scope and relays whether it landed in Unfiled', async () => {
        const response = await POST(request('org:ever'), ctx);

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/knowledge/documents/doc-1/unarchive');
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('ever');
        expect(await response.json()).toEqual({
            document: { id: 'doc-1' },
            restoredToUnfiled: true,
        });
    });

    it('fails closed before upstream when the selector is absent', async () => {
        const response = await POST(request(), ctx);

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

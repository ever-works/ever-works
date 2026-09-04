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

const params = Promise.resolve({ docId: 'doc-1' });

function request(selector?: string) {
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-yo' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/memory/review/doc-1/reject', {
        method: 'POST',
        headers,
    });
}

/**
 * EW-786, the accept twin. `rejectMemoryDocument` refuses with 422 when the
 * request scope names no Organization, so this verb needs the same
 * translation — and needs it in the same change, because the panel offers
 * both buttons on every row it shows.
 */
describe('POST /api/memory/review/[docId]/reject workspace scope', () => {
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

    it('overwrites spoofing and forwards the explicit per-tab Organization selector', async () => {
        const response = await POST(request('org:ever'), { params });

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(String(url)).toBe('http://api.example/memory/review/doc-1/reject');
        const headers = new Headers(init.headers);
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('fails closed before upstream when the browser selector is absent', async () => {
        const response = await POST(request(), { params });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { POST } from './route';

/**
 * The image-upload proxy forwarded only Content-Type + Authorization, so every
 * upload through it — including from an `/org/<slug>/` tab — was persisted as
 * a PERSONAL `user_uploads` row. `UploadsController.upload` stamps the row
 * from the request scope, so forwarding the selector is the whole fix. These
 * drive the real route so they fail if it stops going through `bffProxy`.
 */
function request(opts: { selector?: string; contentType?: string } = {}) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (opts.selector) headers.set('x-ever-workspace', opts.selector);
    headers.set('content-type', opts.contentType ?? 'multipart/form-data; boundary=abc');
    return new NextRequest('http://web.example/api/uploads', {
        method: 'POST',
        headers,
        body: '--abc--',
    });
}

describe('POST /api/uploads — workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: 'a'.repeat(64) }), {
                    status: 201,
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

    function upstream() {
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }];
        return { url, init, headers: new Headers(init.headers) };
    }

    it('forwards the Organization selector as x-scope-slug and overwrites a spoofed one', async () => {
        const response = await POST(request({ selector: 'org:ever' }));

        expect(response.status).toBe(201);
        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/uploads');
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('forwards the personal sentinel rather than nothing', async () => {
        await POST(request({ selector: 'personal' }));

        expect(upstream().headers.get('x-scope-slug')).toBe('@personal');
    });

    it('fails closed with 400 when the selector is missing — an XHR caller must send it', async () => {
        const response = await POST(request());

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 401 for a missing cookie BEFORE looking at the scope', async () => {
        vi.mocked(getAuthAccessCookie).mockResolvedValueOnce(undefined);

        const response = await POST(request());

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still streams the multipart body with its Content-Type intact', async () => {
        await POST(
            request({ selector: 'personal', contentType: 'multipart/form-data; boundary=xyz' }),
        );

        const { init, headers } = upstream();
        expect(headers.get('Content-Type')).toBe('multipart/form-data; boundary=xyz');
        expect(init.method).toBe('POST');
        expect(init.duplex).toBe('half');
        expect(init.body).toBeDefined();
    });
});

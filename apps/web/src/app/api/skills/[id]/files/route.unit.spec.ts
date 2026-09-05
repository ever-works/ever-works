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
 * Skill companion-file uploads. Both rows the API writes (`user_uploads` via
 * `recordUpload`, `skill_files` via `ScopeStampingSubscriber`) take their
 * stamp from the request scope, so a proxy that forwarded only the bearer
 * stamped every org-tab upload personal. It did not even reject a missing
 * cookie — that changes here too. These drive the real route.
 */
function request(opts: { selector?: string } = {}) {
    const headers = new Headers({
        'x-scope-slug': 'attacker-supplied-yo',
        'content-type': 'multipart/form-data; boundary=abc',
    });
    if (opts.selector) headers.set('x-ever-workspace', opts.selector);
    return new NextRequest('http://web.example/api/skills/sk-1/files', {
        method: 'POST',
        headers,
        body: '--abc\r\nContent-Disposition: form-data; name="kind"\r\n\r\nreference\r\n--abc--',
    });
}

const ctx = { params: Promise.resolve({ id: 'sk 1' }) };

describe('POST /api/skills/[id]/files — workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ id: 'sf-1', filename: 'notes.md' }), {
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
        const response = await POST(request({ selector: 'org:ever' }), ctx);

        expect(response.status).toBe(201);
        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/skills/sk%201/files');
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('fails closed with 400 when the selector is missing', async () => {
        const response = await POST(request(), ctx);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 401 for a missing cookie instead of forwarding bearer-less', async () => {
        vi.mocked(getAuthAccessCookie).mockResolvedValueOnce(undefined);

        const response = await POST(request({ selector: 'org:ever' }), ctx);

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('streams the multipart body upstream with its boundary intact', async () => {
        await POST(request({ selector: 'personal' }), ctx);

        const { init, headers } = upstream();
        expect(headers.get('Content-Type')).toBe('multipart/form-data; boundary=abc');
        expect(init.method).toBe('POST');
        expect(init.duplex).toBe('half');
        expect(init.body).toBeDefined();
    });

    it('relays the upstream status and body, including a failure envelope', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Too many files' }), { status: 409 }),
        );

        const response = await POST(request({ selector: 'personal' }), ctx);

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ message: 'Too many files' });
    });
});

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
 * The broader file-upload proxy behind `uploadFile()` (PromptComposer, chat
 * attachments, Mission / Idea / Agent attachments). It forwarded no scope, so
 * every one of those uploads from an `/org/<slug>/` tab was stamped personal —
 * which is also why attaching them to an org entity 404'd (`ownershipWhereWith`
 * is strict in org scope). These drive the real route.
 */
function request(query = '', opts: { selector?: string } = {}) {
    const headers = new Headers({
        'x-scope-slug': 'attacker-supplied-yo',
        'content-type': 'multipart/form-data; boundary=abc',
    });
    if (opts.selector) headers.set('x-ever-workspace', opts.selector);
    return new NextRequest(`http://web.example/api/uploads/file${query}`, {
        method: 'POST',
        headers,
        body: '--abc--',
    });
}

describe('POST /api/uploads/file — workspace scope', () => {
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
        const response = await POST(request('', { selector: 'org:ever' }));

        expect(response.status).toBe(201);
        const { url, headers } = upstream();
        expect(url).toBe('http://api.example/uploads/file');
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('forwards the personal sentinel rather than nothing', async () => {
        await POST(request('', { selector: 'personal' }));

        expect(upstream().headers.get('x-scope-slug')).toBe('@personal');
    });

    it('fails closed with 400 when the selector is missing', async () => {
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

    it('keeps the workId allowlist: workId is forwarded, any other key is dropped', async () => {
        await POST(request('?workId=w-1&scope=org:ever&evil=1', { selector: 'org:ever' }));

        const { url, init, headers } = upstream();
        expect(url).toBe('http://api.example/uploads/file?workId=w-1');
        expect(headers.get('Content-Type')).toBe('multipart/form-data; boundary=abc');
        expect(init.duplex).toBe('half');
    });
});

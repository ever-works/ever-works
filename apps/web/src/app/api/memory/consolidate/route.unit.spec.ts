import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { POST } from './route';

/**
 * Same live bug as the sibling GET, but this one WRITES. Without a forwarded
 * scope the `{ apply: true }` pass ran in PERSONAL scope, so a consolidation
 * started from `/org/<slug>/memory` could never persist into that Organization
 * — it silently operated on the wrong workspace and reported success.
 */
function request(body: unknown, selector?: string, referer?: string) {
    const headers = new Headers({
        'content-type': 'application/json',
        'x-scope-slug': 'attacker-supplied-yo',
    });
    if (selector) headers.set('x-ever-workspace', selector);
    if (referer) headers.set('referer', referer);
    return new Request('http://web.example/api/memory/consolidate', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0];
}

describe('POST /api/memory/consolidate workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () => new Response(JSON.stringify({ scanned: 0 }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        delete process.env.WEB_URL;
    });

    it('forwards the Organization selector on the dry-run pass', async () => {
        const response = await POST(request({ apply: false }, 'org:ever'));

        expect(response.status).toBe(200);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('ever');
    });

    it('forwards the Organization selector on the APPLYING pass', async () => {
        // The write. Getting this wrong consolidates into the wrong workspace.
        await POST(request({ apply: true }, 'org:ever'));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('ever');
        expect(init.body).toBe(JSON.stringify({ apply: true }));
    });

    it('overwrites a spoofed x-scope-slug and strips the browser selector', async () => {
        await POST(request({ apply: true }, 'org:ever'));

        const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
    });

    it('refuses to WRITE at all when no selector is present', async () => {
        const response = await POST(request({ apply: true }));

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a selector that disagrees with the Referer path', async () => {
        const response = await POST(
            request({ apply: true }, 'org:ever', 'http://web.example/org/yo/memory'),
        );

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the JSON content type and the bearer token', async () => {
        await POST(request({ apply: false }, 'org:ever'));

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/memory/consolidate');
        const headers = new Headers(init.headers);
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });
});

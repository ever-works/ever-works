import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: vi.fn(async () => 'fake-jwt'),
}));

vi.mock('@/lib/constants', () => ({
    API_URL: 'http://api.example',
}));

import { GET } from './route';

/**
 * Regression cover for a LIVE production bug: this proxy forwarded no workspace
 * scope at all. Commit 8f28edca0 retired `SessionScopeGuard`'s last-active-Org
 * fallback, so an unscoped call resolves to PERSONAL — meaning `/org/<slug>/memory`
 * rendered correctly server-side and then emptied on the first keystroke, because
 * the client-side refetch came through here.
 *
 * Nothing upstream can compensate: Next middleware stamps the browser selector but
 * its matcher excludes `/api`, so the header only arrives if the caller sends it
 * and this route forwards it.
 */
function request(selector?: string, referer?: string) {
    // A spoofed upstream header is present on purpose: the BFF must overwrite it
    // rather than pass a caller-chosen scope through to the API.
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (selector) headers.set('x-ever-workspace', selector);
    if (referer) headers.set('referer', referer);

    const url = 'http://web.example/api/memory?q=notes';
    const req = new Request(url, { method: 'GET', headers });
    // A real Request carries the headers the scope guard reads; `nextUrl` is the
    // one thing NextRequest adds that this route uses (for the query string).
    Object.defineProperty(req, 'nextUrl', { value: new URL(url) });
    return req as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/memory workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
        fetchMock = vi.fn(
            async () => new Response(JSON.stringify({ documents: [] }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        delete process.env.WEB_URL;
    });

    it('forwards the per-tab Organization selector as x-scope-slug', async () => {
        const response = await GET(request('org:ever'));

        expect(response.status).toBe(200);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('ever');
    });

    it('overwrites a spoofed x-scope-slug rather than trusting the caller', async () => {
        await GET(request('org:ever'));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        // 'attacker-supplied-yo' was set by the caller and must not survive.
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('ever');
    });

    it('does not leak the browser selector header upstream', async () => {
        await GET(request('org:ever'));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-ever-workspace')).toBeNull();
    });

    it('forwards the personal sentinel when the tab is in personal scope', async () => {
        await GET(request('personal'));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get('x-scope-slug')).toBe('@personal');
    });

    it('fails closed before calling upstream when no selector is present', async () => {
        const response = await GET(request());

        // Silently defaulting to personal is exactly the bug this fixes: the user
        // sees an empty Org feed and no error. A 400 makes the mistake loud.
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a selector that disagrees with the Referer path', async () => {
        const response = await GET(request('org:ever', 'http://web.example/org/yo/memory'));

        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still carries the bearer token and the query string', async () => {
        await GET(request('org:ever'));

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://api.example/memory?q=notes');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-jwt');
    });
});

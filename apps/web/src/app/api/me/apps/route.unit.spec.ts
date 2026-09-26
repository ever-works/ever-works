import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * APW-11 T14 (route half) — `GET /api/me/apps`.
 *
 * The route is a proxy, so the assertions are about what survives the hop:
 *
 *  1. **the workspace scope reaches the API** — this is the one that matters,
 *     because T14's own warning is about a route that sets only
 *     `Authorization`: the API then resolves the request as PERSONAL scope
 *     (`scope-resolver.middleware.ts`) and every Organization-scoped Work
 *     disappears from the launcher, silently, as an empty list
 *     (ACC-11-24 unit half, APW11-G04). The browser's `x-ever-workspace`
 *     selector must become the API's `x-scope-slug` header, and the browser
 *     header must NOT travel upstream;
 *  2. **a missing or malformed selector fails closed** — `400`, with no
 *     upstream request at all, so the panel can never show a personal-scope
 *     list to somebody working in an Organization;
 *  3. **only `includeHidden` is forwarded**, and only as the literal
 *     `'true'`/`'false'` the API's DTO accepts, so the route is not an open
 *     proxy;
 *  4. **the token is never in the upstream URL** — it travels in the
 *     `Authorization` header;
 *  5. the upstream **status**, **body** and **content type** pass through
 *     unchanged, including the `404` that means "the App Launcher is switched
 *     off".
 *
 * `bffProxy` is deliberately NOT mocked: (1), (2) and (4) are properties of the
 * real wiring, so the spec mocks its inputs (the auth cookie) and inspects the
 * `fetch` it performs.
 *
 * The header names and the `@personal` sentinel below are asserted as LITERALS
 * on purpose. `apps/web/src/lib/workspace-scope.ts` is a runtime twin of
 * `@ever-works/contracts/api`; importing the constants here would make this spec
 * agree with a rename in the twin instead of catching it.
 */

const fetchMock = vi.fn();

vi.mock('@/lib/auth/cookies', () => ({
    getAuthAccessCookie: async () => 'session-token',
}));

import { GET } from './route';
import { API_URL } from '@/lib/constants';

const APPS_URL = `${API_URL}/me/apps`;

/**
 * Call the route with the given browser selector. `selector: null` omits the
 * header entirely, which is the "our transport forgot to stamp the request"
 * case; the wire grammar itself is `personal` | `org:<slug>`
 * (`serializeWorkspaceScope`).
 */
function callRoute(path: string, selector: string | null = 'org:acme'): Promise<Response> {
    const request = new NextRequest(new URL(path, 'https://app.example.test'));
    if (selector !== null) request.headers.set('x-ever-workspace', selector);
    return GET(request);
}

function upstream(body: string, status = 200, contentType = 'application/json'): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers({ 'content-type': contentType }),
        text: async () => body,
    } as unknown as Response;
}

/** The headers of the n-th (0-based) upstream request. */
function sentHeaders(index = 0): Headers {
    const call = fetchMock.mock.calls[index] as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    return new Headers(call?.[1]?.headers);
}

function sentUrl(index = 0): string {
    const call = fetchMock.mock.calls[index] as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    return String(call?.[0]);
}

describe('GET /api/me/apps (APW-11 T14)', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(upstream('{"items":[],"meta":{}}'));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('forwards the workspace scope header to the API', async () => {
        await callRoute('/api/me/apps');

        const sent = sentHeaders();
        // The browser's header is the INPUT; the API scope header is the OUTPUT.
        expect(sent.get('x-scope-slug')).toBe('acme');
        expect(sent.has('x-ever-workspace')).toBe(false);
    });

    it('treats an explicit personal selector as the personal scope', async () => {
        await callRoute('/api/me/apps', 'personal');

        expect(sentHeaders().get('x-scope-slug')).toBe('@personal');
    });

    it('refuses a missing selector instead of quietly reading personal scope', async () => {
        const response = await callRoute('/api/me/apps', null);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'Invalid workspace scope' });
    });

    it('refuses a malformed selector instead of quietly reading personal scope', async () => {
        // 'acme' is a slug, not a selector: the wire grammar is `org:acme`.
        const response = await callRoute('/api/me/apps', 'acme');

        expect(fetchMock).not.toHaveBeenCalled();
        expect(response.status).toBe(400);
    });

    it('refuses a selector that disagrees with the page the request came from', async () => {
        // A stale selector (an Organization tab's header on a personal page)
        // must not be believed: the inherited referer check makes the copied
        // and edited request fail rather than read across scopes.
        const request = new NextRequest(new URL('/api/me/apps', 'https://app.example.test'));
        request.headers.set('x-ever-workspace', 'org:acme');
        request.headers.set('referer', 'https://app.example.test/dashboard');

        const response = await GET(request);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(response.status).toBe(400);
    });

    it('answers 401 without a session cookie', async () => {
        vi.resetModules();
        vi.doMock('@/lib/auth/cookies', () => ({ getAuthAccessCookie: async () => undefined }));
        const { GET: GETWithoutSession } = await import('./route');

        const response = await GETWithoutSession(
            new NextRequest(new URL('/api/me/apps', 'https://app.example.test')),
        );

        expect(response.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();

        vi.doUnmock('@/lib/auth/cookies');
        vi.resetModules();
    });

    it('forwards only includeHidden, and only when it is a literal boolean', async () => {
        await callRoute('/api/me/apps?includeHidden=true&limit=999&scope=other');

        const url = sentUrl();
        expect(url.startsWith(APPS_URL)).toBe(true);
        expect(url).toContain('includeHidden=true');
        expect(url).not.toContain('limit');
        expect(url).not.toContain('scope=other');

        fetchMock.mockClear();
        fetchMock.mockResolvedValue(upstream('{"items":[],"meta":{}}'));
        await callRoute('/api/me/apps?includeHidden=maybe');
        expect(sentUrl()).not.toContain('includeHidden');

        fetchMock.mockClear();
        fetchMock.mockResolvedValue(upstream('{"items":[],"meta":{}}'));
        await callRoute('/api/me/apps?includeHidden=false');
        expect(sentUrl()).toContain('includeHidden=false');
    });

    it('never puts the token in the upstream URL', async () => {
        await callRoute('/api/me/apps');

        expect(sentUrl()).not.toContain('session-token');
        expect(sentUrl()).not.toContain('token');
        expect(sentHeaders().get('Authorization')).toBe('Bearer session-token');
    });

    it('passes the upstream status and body through unchanged', async () => {
        const payload = {
            items: [{ key: 'work:w1', kind: 'work', section: 'pinned' }],
            meta: { environment: 'production', appWorksAvailable: true },
        };
        fetchMock.mockResolvedValue(upstream(JSON.stringify(payload)));

        const response = await callRoute('/api/me/apps');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(response.headers.get('cache-control')).toBe('no-store');
        await expect(response.json()).resolves.toEqual(payload);
    });

    it('passes the API’s 404 through — the launcher switched off is not a 200 with an empty list', async () => {
        fetchMock.mockResolvedValue(upstream('{"message":"Cannot find route"}', 404));

        const response = await callRoute('/api/me/apps');

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ message: 'Cannot find route' });
    });

    it('answers 502 with its own copy when the upstream is unreachable', async () => {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

        const response = await callRoute('/api/me/apps');

        expect(response.status).toBe(502);
        // Never the upstream message — it can carry an address or a Work name.
        await expect(response.json()).resolves.toEqual({ error: 'failed_to_load_apps' });
    });

    it('answers the upstream status even when its body cannot be read', async () => {
        fetchMock.mockResolvedValue({
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => {
                throw new Error('socket hang up');
            },
        } as unknown as Response);

        const response = await callRoute('/api/me/apps');

        // The status is what the panel keys on; a read failure degrades to an
        // empty body rather than turning a 404 into a gateway error.
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('');
    });
});

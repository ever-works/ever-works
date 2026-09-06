import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { API_SCOPE_HEADER, BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

const { getAuthAccessCookieMock } = vi.hoisted(() => ({
    getAuthAccessCookieMock: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }));
vi.mock('@/lib/auth/cookies', () => ({ getAuthAccessCookie: getAuthAccessCookieMock }));

import { GET, PUT } from './route';

const URL_UNDER_TEST = 'https://app.example/api/memory/consolidation/settings';

const STORED = {
    enabled: true,
    cadence: 'weekly',
    mode: 'propose',
    notify: true,
    lastRunAt: null,
};

function build(method: 'GET' | 'PUT', selector?: string, body?: string): NextRequest {
    const headers = new Headers();
    if (selector !== undefined) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest(URL_UNDER_TEST, { method, headers, body });
}

/**
 * `OrgMemoryController` resolves the Organization from
 * `ScopeContextService.getOrganizationId()`, which the platform fills only
 * from an `/api/<slug>/…` path or the `X-Scope-Slug` header. This proxy is
 * the only thing that can produce that header for the Memory schedule
 * panel, so the two halves are pinned together: the selector the browser
 * sends becomes the API scope, and no selector means no upstream call.
 *
 * Before EW-786 neither handler looked at the selector, so on
 * `/org/<slug>/memory` the GET returned the personal-scope defaults rather
 * than the stored settings and the PUT was refused 422 by the API — the
 * schedule could not be turned on for any Organization.
 */
describe('/api/memory/consolidation/settings workspace scope', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthAccessCookieMock.mockResolvedValue('access-token');
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify(STORED), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        );
    });

    it('GET forwards the browser selector to the platform as the API scope header', async () => {
        const response = await GET(build('GET', 'org:ever'));

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ enabled: true, mode: 'propose' });
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toMatch(/\/memory\/consolidation\/settings$/);
        const forwarded = new Headers(init?.headers);
        expect(forwarded.get(API_SCOPE_HEADER)).toBe('ever');
        // The browser-facing selector is an internal transport detail and
        // must not leak to the platform.
        expect(forwarded.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
    });

    it('PUT forwards the selector alongside the patch body', async () => {
        const response = await PUT(build('PUT', 'org:ever', JSON.stringify({ enabled: true })));

        expect(response.status).toBe(200);
        const [, init] = vi.mocked(fetch).mock.calls[0];
        const forwarded = new Headers(init?.headers);
        expect(forwarded.get(API_SCOPE_HEADER)).toBe('ever');
        expect(init?.body).toBe(JSON.stringify({ enabled: true }));
        // Scoping rebuilt the header set; the auth and content headers the
        // platform needs have to survive that.
        expect(forwarded.get('authorization')).toBe('Bearer access-token');
        expect(forwarded.get('content-type')).toBe('application/json');
    });

    it('translates an unprefixed tab into the explicit personal sentinel', async () => {
        await GET(build('GET', 'personal'));

        const [, init] = vi.mocked(fetch).mock.calls[0];
        expect(new Headers(init?.headers).get(API_SCOPE_HEADER)).toBe('@personal');
    });

    it('GET fails closed without a selector: 400 and no upstream call', async () => {
        const response = await GET(build('GET'));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('PUT fails closed without a selector, so nothing is written to the wrong scope', async () => {
        const response = await PUT(build('PUT', undefined, JSON.stringify({ enabled: true })));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('PUT rejects a malformed selector rather than falling back to personal', async () => {
        const response = await PUT(build('PUT', 'org:Not A Slug', '{}'));

        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('answers 401 before any scope work when the auth cookie is absent', async () => {
        getAuthAccessCookieMock.mockResolvedValue(null);

        const response = await GET(build('GET', 'org:ever'));

        expect(response.status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });
});

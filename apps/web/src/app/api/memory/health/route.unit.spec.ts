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

function request(selector?: string) {
    // A spoofed API scope header rides along on purpose: the browser may
    // select a workspace, never name the Organization the API resolves.
    const headers = new Headers({ [API_SCOPE_HEADER]: 'attacker-supplied-yo' });
    if (selector) headers.set(BROWSER_WORKSPACE_SCOPE_HEADER, selector);
    return new NextRequest('http://web.example/api/memory/health?windowDays=7', { headers });
}

/**
 * EW-786. `OrgMemoryController.getMemoryHealth` reads the Organization off
 * the request scope and returns `emptyHealth()` — all counts 0, every rate
 * `null` — when there is none. That scope only ever holds an Organization
 * when `x-scope-slug` arrives (`SessionScopeGuard` refuses to read the
 * user's stored last-Organization preference), so an unscoped proxy hop
 * made `MemoryHealthService.getOrgHealth` unreachable from the web app for
 * every session. It did not fail: it reported a confident, measurable zero
 * over real retrieval history, which is the one thing `KbMemoryHealthPanel`
 * is written not to show.
 */
describe('GET /api/memory/health workspace scope', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(
            async () =>
                new Response(JSON.stringify({ windowDays: 7, recallHitRate: null }), {
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
        const response = await GET(request('org:ever'));

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        // The metric window survives the hop; only the scope headers change.
        expect(String(url)).toBe('http://api.example/memory/health?windowDays=7');
        const headers = new Headers(init.headers);
        expect(headers.get(API_SCOPE_HEADER)).toBe('ever');
        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBeNull();
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('forwards a genuinely personal workspace as the personal sentinel', async () => {
        await GET(request('personal'));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('@personal');
    });

    it('fails closed before upstream when the browser selector is absent', async () => {
        const response = await GET(request());

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

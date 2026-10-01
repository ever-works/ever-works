import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getAuthFromCookieMock, getUpstreamMock } = vi.hoisted(() => ({
    getAuthFromCookieMock: vi.fn(),
    getUpstreamMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getAuthFromCookie: getAuthFromCookieMock }));
vi.mock('@/lib/api/work', () => ({ workAPI: { getUpstream: getUpstreamMock } }));

import { ApiResponseError } from '@/lib/api/server-api';
import { GET } from './route';

const params = Promise.resolve({ id: 'w1' });
const request = () => new NextRequest('http://localhost:3211/api/works/w1/upstream');
/** A request carrying the browser's per-tab selector, as `browserApiFetch` sends it. */
const scopedRequest = (selector: string) =>
    new NextRequest('http://localhost:3211/api/works/w1/upstream', {
        headers: { 'x-ever-workspace': selector },
    });

/**
 * The Upstream card's poll read door (APW-02 T30).
 *
 * Like its sibling `app-spec/route.ts`, this route is **hand-written** — it does
 * not go through `bffProxy` — so it owns the failure surface for the browser's
 * per-tab workspace selector itself. The selector is resolved inside
 * `getAuthFromCookie()` (`serverFetch` → `parseWorkspaceSelector`), which fails
 * closed with `Invalid workspace scope` when `x-ever-workspace` is absent or
 * does not parse. The call sat BEFORE this handler's `try`, so the throw escaped
 * and the caller got an **empty 500** — measured on the e2e lane for this exact
 * route (`e2e/flow-app-spec-settings.spec.ts`, the poll-read case) — where every
 * `bffProxy`-built route and the App spec poll route answer the documented
 * `400 { error: 'Invalid workspace scope' }` (`bffProxy`'s catch around
 * `applyBffWorkspaceScope` in `lib/api/bff-proxy.ts`). These cases pin the
 * corrected surface and the forwarding the card relies on.
 */
describe('GET /api/works/[id]/upstream', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromCookieMock.mockResolvedValue({ id: 'u1' });
    });

    it('answers 400 with the house envelope when the workspace selector is missing or unparseable', async () => {
        // What the real helper does when the browser's per-tab selector is absent:
        // `serverFetch` runs `parseWorkspaceSelector` and throws.
        getAuthFromCookieMock.mockRejectedValue(new Error('Invalid workspace scope'));

        const response = await GET(request(), { params });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(getUpstreamMock).not.toHaveBeenCalled();
    });

    it('answers the same 400 for a selector that is present but does not parse', async () => {
        getAuthFromCookieMock.mockRejectedValue(new Error('Invalid workspace scope'));

        const response = await GET(scopedRequest('org:Not A Slug'), { params });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(getUpstreamMock).not.toHaveBeenCalled();
    });

    it('does not label a profile-read failure as a scope error: it escapes as before the catch existed', async () => {
        // The selector is valid, so `serverFetch` resolved the scope and sent
        // `/auth/profile`, which answered 5xx; `getAuthFromCookie()` rethrows any
        // non-401, non-network failure (`lib/auth/index.ts`). Answering that with
        // 400 'Invalid workspace scope' would tell the caller to fix a header it
        // sent correctly. It keeps the route's behaviour from before the scope
        // catch: the throw leaves the handler and Next answers 500.
        const failure = new ApiResponseError('Internal server error', 503, 'service_unavailable');
        getAuthFromCookieMock.mockRejectedValue(failure);

        await expect(GET(scopedRequest('personal'), { params })).rejects.toBe(failure);
        expect(getUpstreamMock).not.toHaveBeenCalled();
    });

    it('answers 401 and never touches the API when there is no session', async () => {
        getAuthFromCookieMock.mockResolvedValue(null);

        const response = await GET(request(), { params });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ status: 'error', code: 'unauthorized' });
        expect(getUpstreamMock).not.toHaveBeenCalled();
    });

    it('forwards the API read unchanged when the session is valid', async () => {
        const state = { readiness: 'ready', syncInProgress: false };
        getUpstreamMock.mockResolvedValue(state);

        const response = await GET(request(), { params });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(state);
        expect(getUpstreamMock).toHaveBeenCalledWith('w1');
    });

    it('forwards the API refusal as the API wrote it, status and body', async () => {
        getUpstreamMock.mockRejectedValue(
            new ApiResponseError('Work w1 not found', 404, 'not_found', {
                status: 'error',
                code: 'not_found',
                message: 'Work w1 not found',
            }),
        );

        const response = await GET(request(), { params });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            status: 'error',
            code: 'not_found',
            message: 'Work w1 not found',
        });
    });

    it('answers 500 only for a failure the API did not classify', async () => {
        getUpstreamMock.mockRejectedValue(new Error('socket hang up'));

        const response = await GET(request(), { params });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ status: 'error', code: 'failed' });
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getAuthFromCookieMock, getMock } = vi.hoisted(() => ({
    getAuthFromCookieMock: vi.fn(),
    getMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getAuthFromCookie: getAuthFromCookieMock }));
vi.mock('@/lib/api/work-app-spec', () => ({ workAppSpecAPI: { get: getMock } }));

import { ApiResponseError } from '@/lib/api/server-api';
import { GET } from './route';

const params = Promise.resolve({ id: 'w1' });
const request = () => new NextRequest('http://localhost:3211/api/works/w1/app-spec');
/** A request carrying the browser's per-tab selector, as `browserApiFetch` sends it. */
const scopedRequest = (selector: string) =>
    new NextRequest('http://localhost:3211/api/works/w1/app-spec', {
        headers: { 'x-ever-workspace': selector },
    });

/**
 * The App spec poll's read door (APW-03 T17).
 *
 * This route is **hand-written** — it does not go through the shared `bffProxy`
 * factory — so it owns the failure surface for the workspace selector itself.
 * Measured on a lane before this spec existed: with a valid session and **no**
 * `x-ever-workspace` selector, the scope resolution inside `getAuthFromCookie()`
 * threw and the throw escaped the handler (it sat *before* the `try`), so the
 * caller got an **empty 500** while every `bffProxy`-built route answers the
 * documented `400 { error: 'Invalid workspace scope' }` (`bffProxy`'s catch
 * around `applyBffWorkspaceScope` in `lib/api/bff-proxy.ts`). These cases pin
 * the corrected surface, and the 404/200 forwarding the page actually depends on.
 */
describe('GET /api/works/[id]/app-spec', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromCookieMock.mockResolvedValue({ id: 'u1' });
    });

    it('answers 400 with the house envelope when the workspace selector is missing or unparseable', async () => {
        // What the real helper does when the browser's per-tab selector is absent:
        // `applyBffWorkspaceScope` fails closed and throws.
        getAuthFromCookieMock.mockRejectedValue(new Error('Invalid workspace scope'));

        const response = await GET(request(), { params });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(getMock).not.toHaveBeenCalled();
    });

    it('answers the same 400 for a selector that is present but does not parse', async () => {
        getAuthFromCookieMock.mockRejectedValue(new Error('Invalid workspace scope'));

        const response = await GET(scopedRequest('org:Not A Slug'), { params });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid workspace scope' });
        expect(getMock).not.toHaveBeenCalled();
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
        expect(getMock).not.toHaveBeenCalled();
    });

    it('answers 401 and never touches the API when there is no session', async () => {
        getAuthFromCookieMock.mockResolvedValue(null);

        const response = await GET(request(), { params });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ status: 'error', code: 'unauthorized' });
        expect(getMock).not.toHaveBeenCalled();
    });

    it('forwards the API read unchanged when the session is valid', async () => {
        const state = { status: 'valid', evaluationPending: false };
        getMock.mockResolvedValue(state);

        const response = await GET(request(), { params });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(state);
        expect(getMock).toHaveBeenCalledWith('w1');
    });

    it('forwards the API refusal as the API wrote it, status and body', async () => {
        // The page renders the state, never an error string: re-wording the API's
        // own code here would give the banner a second vocabulary.
        getMock.mockRejectedValue(
            new ApiResponseError('Work w1 has no App spec state yet.', 404, 'not_found', {
                status: 'error',
                code: 'not_found',
                message: 'Work w1 has no App spec state yet.',
            }),
        );

        const response = await GET(request(), { params });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            status: 'error',
            code: 'not_found',
            message: 'Work w1 has no App spec state yet.',
        });
    });

    it('answers 500 only for a failure the API did not classify', async () => {
        getMock.mockRejectedValue(new Error('socket hang up'));

        const response = await GET(request(), { params });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ status: 'error', code: 'failed' });
    });
});

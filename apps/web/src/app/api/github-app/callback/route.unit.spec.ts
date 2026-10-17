import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Prod 2026-10-09 — after installing the platform GitHub App and approving the
 * user authorization, the browser landed on
 * `https://ever-works-web-7c47bf599d-dc74b:3000/auth/error?error=oauth_callback`
 * ("server IP address could not be found"). Every redirect here was built with
 * `new URL(path, request.url)`, and inside the Next server `request.url` is the
 * pod's own bind address, never the browser-facing URL.
 *
 * The requests below are deliberately addressed to that INTERNAL pod origin,
 * exactly as Next hands them to the route in production, so a regression back
 * to `request.url` fails every redirect-origin assertion.
 */

const { setAuthCookiesMock } = vi.hoisted(() => ({ setAuthCookiesMock: vi.fn() }));

vi.mock('@/lib/auth', () => ({ setAuthCookies: setAuthCookiesMock }));

import { GET } from './route';

const INTERNAL_ORIGIN = 'https://ever-works-web-7c47bf599d-dc74b:3000';
const PUBLIC_ORIGIN = 'https://app.ever.works';

function callbackRequest(query = 'code=c0de&state=s1gned'): NextRequest {
    return new NextRequest(`${INTERNAL_ORIGIN}/api/github-app/callback?${query}`);
}

function apiAnswers(body: unknown, status = 200) {
    const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
            }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function locationOf(response: Response): URL {
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    return new URL(location as string);
}

describe('GET /api/github-app/callback', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_WEB_URL', PUBLIC_ORIGIN);
        vi.stubEnv('WEB_URL', PUBLIC_ORIGIN);
        setAuthCookiesMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('redirects to the PUBLIC origin, never the internal pod host', () => {
        it('API refusal (the incident) -> public /auth/error', async () => {
            apiAnswers({ message: 'Internal server error' }, 500);

            const url = locationOf(await GET(callbackRequest()));

            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/auth/error');
            expect(url.searchParams.get('error')).toBe('oauth_callback');
            expect(setAuthCookiesMock).not.toHaveBeenCalled();
        });

        it('API answer without an access token -> public /auth/error', async () => {
            apiAnswers({ installationId: '169597044' });

            const url = locationOf(await GET(callbackRequest()));

            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/auth/error');
            expect(setAuthCookiesMock).not.toHaveBeenCalled();
        });

        it('success with a safe redirectTo -> that path on the public origin, with the install markers', async () => {
            apiAnswers({
                access_token: 'session-jwt',
                installationId: '169597044',
                redirectTo: '/settings/github-app?tab=installations',
            });

            const url = locationOf(await GET(callbackRequest()));

            expect(setAuthCookiesMock).toHaveBeenCalledWith('session-jwt');
            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/settings/github-app');
            expect(url.searchParams.get('tab')).toBe('installations');
            expect(url.searchParams.get('github_app_connected')).toBe('true');
            expect(url.searchParams.get('installation_id')).toBe('169597044');
        });

        it('success without redirectTo -> /settings on the public origin', async () => {
            apiAnswers({ access_token: 'session-jwt', installationId: '169597044' });

            const url = locationOf(await GET(callbackRequest()));

            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/settings');
        });

        it('a malformed NEXT_PUBLIC_WEB_URL falls through to a valid WEB_URL, not to the pod host', async () => {
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'app.ever.works');
            vi.stubEnv('WEB_URL', PUBLIC_ORIGIN);
            apiAnswers({ access_token: 'session-jwt' });

            const url = locationOf(await GET(callbackRequest()));

            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/settings');
        });

        it('falls back to the request origin only when no public origin is configured (bare local dev)', async () => {
            vi.stubEnv('NEXT_PUBLIC_WEB_URL', '');
            vi.stubEnv('WEB_URL', '');
            apiAnswers({ access_token: 'session-jwt' });

            const url = locationOf(
                await GET(new NextRequest('http://localhost:3000/api/github-app/callback?code=c')),
            );

            expect(url.origin).toBe('http://localhost:3000');
            expect(url.pathname).toBe('/settings');
        });
    });

    it('forwards the GitHub query to the API callback unchanged', async () => {
        const fetchMock = apiAnswers({ access_token: 'session-jwt' });

        await GET(callbackRequest('code=abc&state=xyz'));

        const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
        expect(calledUrl.pathname).toMatch(/\/github-app\/callback$/);
        expect(calledUrl.searchParams.get('code')).toBe('abc');
        expect(calledUrl.searchParams.get('state')).toBe('xyz');
    });

    describe('open-redirect protection is intact (compared against the PUBLIC origin)', () => {
        it.each([
            ['protocol-relative', '//evil.example/steal'],
            ['backslash variant', '/\\evil.example/steal'],
            ['absolute foreign URL', 'https://evil.example/steal'],
            ['absolute URL on the internal pod host', `${INTERNAL_ORIGIN}/settings`],
            ['no leading slash', 'evil.example'],
            ['javascript scheme', 'javascript:alert(1)'],
        ])('%s redirectTo is refused -> /settings on the public origin', async (_label, target) => {
            apiAnswers({
                access_token: 'session-jwt',
                installationId: '1',
                redirectTo: target,
            });

            const url = locationOf(await GET(callbackRequest()));

            expect(url.origin).toBe(PUBLIC_ORIGIN);
            expect(url.pathname).toBe('/settings');
            expect(url.searchParams.get('installation_id')).toBe('1');
        });
    });

    // 10-09 handover item 13 — the setup's browser-binding cookie goes to the
    // API as a server-to-server header, and is single-use.
    describe('browser binding (item 13)', () => {
        it('forwards the binding cookie as a header and clears it', async () => {
            const fetchMock = apiAnswers({ access_token: 'tok', installationId: '169597044' });
            const request = new NextRequest(
                `${INTERNAL_ORIGIN}/api/github-app/callback?code=c&state=s`,
                {
                    headers: { cookie: 'ew_github_app_setup=nonce-1' },
                },
            );

            const response = await GET(request);

            const init = fetchMock.mock.calls[0][1] as RequestInit;
            expect((init.headers as Record<string, string>)['X-Ever-Works-Setup-Binding']).toBe(
                'nonce-1',
            );
            const cleared = response.headers.get('set-cookie') ?? '';
            expect(cleared).toContain('ew_github_app_setup=');
            expect(cleared).toMatch(/Max-Age=0/i);
        });

        it('sends no binding header when the browser has no cookie (the API then refuses)', async () => {
            const fetchMock = apiAnswers(
                { message: 'Finish the GitHub App setup in the browser where you started it' },
                400,
            );
            const url = locationOf(await GET(callbackRequest()));
            const init = fetchMock.mock.calls[0][1] as RequestInit;
            expect(init.headers as Record<string, string>).not.toHaveProperty(
                'X-Ever-Works-Setup-Binding',
            );
            expect(url.pathname).toBe('/auth/error');
        });
    });
});

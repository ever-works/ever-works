import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_SCOPE_HEADER } from '../workspace-scope';

const { getAuthAccessCookieMock, headersMock, translationsMock } = vi.hoisted(() => ({
    getAuthAccessCookieMock: vi.fn(),
    headersMock: vi.fn(),
    translationsMock: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('../auth/cookies', () => ({ getAuthAccessCookie: getAuthAccessCookieMock }));
vi.mock('next-intl/server', () => ({ getTranslations: translationsMock }));
vi.mock('../constants', () => ({
    ALLOWED_REDIRECT_URLS: ['app.example'],
    API_URL: 'https://api.example',
    ROUTES: { DASHBOARD: '/' },
    WEB_URL: 'https://app.example',
}));

import { authAPI } from './auth';
import { OAuthProvider } from './enums';

/**
 * The OAuth provider redirects the browser to `/api/oauth/:p/callback` as a
 * TOP-LEVEL navigation. `/api/*` is excluded from the proxy matcher, so the
 * request never carries the proxy-injected `x-ever-workspace` selector that
 * `serverFetch` otherwise fails closed on. The exchange must therefore opt
 * into personal scope explicitly — a login is never Organization-scoped.
 *
 * Regression: 2026-08-23 (`8f28edca0`) made the selector mandatory and every
 * GitHub/Google login on app.ever.works ended at
 * `/auth/error?error=oauth_callback` without a single log line, because the
 * throw happened before the API was called and the handler swallowed it.
 */
describe('authAPI.connectOAuthCallback on a top-level provider redirect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // A signed-out browser: no auth cookie, no proxy workspace selector.
        getAuthAccessCookieMock.mockResolvedValue(undefined);
        headersMock.mockResolvedValue(new Headers({ host: 'app.example' }));
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            access_token: 'session-token',
                            user: { id: 'u1', username: 'u', email: 'u@example.com' },
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    ),
            ),
        );
    });

    it.each([OAuthProvider.GITHUB, OAuthProvider.GOOGLE])(
        'exchanges the %s code under personal scope without a proxy selector',
        async (provider) => {
            const result = await authAPI.connectOAuthCallback(provider, 'code-1', 'state-1');

            expect(result.access_token).toBe('session-token');
            expect(fetch).toHaveBeenCalledTimes(1);

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(url).toBe(
                `https://api.example/oauth/${provider}/callback?code=code-1&state=state-1`,
            );

            const sent = new Headers(init?.headers);
            expect(sent.get(API_SCOPE_HEADER)).toBe('@personal');
            // C-03: the API re-verifies `state` against its own cookie name.
            expect(sent.get('cookie')).toBe('ew_oauth_state=state-1');
            expect(sent.get('authorization')).toBeNull();
        },
    );

    it('still fails closed for the URL-issuing call, which only runs on proxied pages (control)', async () => {
        await expect(authAPI.getOAuthAuthUrl(OAuthProvider.GITHUB)).rejects.toThrow(
            'Invalid workspace scope',
        );
        expect(fetch).not.toHaveBeenCalled();
    });
});

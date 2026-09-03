import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_SCOPE_HEADER } from '../../workspace-scope';

const { getAuthAccessCookieMock, headersMock, translationsMock } = vi.hoisted(() => ({
    getAuthAccessCookieMock: vi.fn(),
    headersMock: vi.fn(),
    translationsMock: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('../../auth/cookies', () => ({ getAuthAccessCookie: getAuthAccessCookieMock }));
vi.mock('next-intl/server', () => ({ getTranslations: translationsMock }));
vi.mock('../../constants', () => ({
    ALLOWED_REDIRECT_URLS: ['app.example'],
    API_URL: 'https://api.example',
    ROUTES: { DASHBOARD: '/' },
    WEB_URL: 'https://app.example',
}));

import { oauthAPI } from './oauth';

/**
 * Same shape as the login callback: `/api/oauth/:p/callback/plugins[/read-packages]`
 * is a top-level redirect from the provider, outside the proxy matcher, so no
 * `x-ever-workspace` selector is present. The API binds the connection to
 * `req.user.userId` — it is personal by construction.
 */
describe('oauthAPI provider-connect callbacks on a top-level provider redirect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Signed-in user (the connect flow requires a session) but no proxy selector.
        getAuthAccessCookieMock.mockResolvedValue('access-token');
        headersMock.mockResolvedValue(new Headers({ host: 'app.example' }));
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ id: 'github', connected: true }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        );
    });

    it('connectCallback exchanges the code under personal scope', async () => {
        await oauthAPI.connectCallback('github', 'code-1', 'state-1');

        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe(
            'https://api.example/oauth/github/callback/plugins?code=code-1&state=state-1',
        );
        const sent = new Headers(init?.headers);
        expect(sent.get(API_SCOPE_HEADER)).toBe('@personal');
        expect(sent.get('cookie')).toBe('ew_oauth_state=state-1');
        expect(sent.get('authorization')).toBe('Bearer access-token');
    });

    it('readPackagesCallback exchanges the code under personal scope', async () => {
        await oauthAPI.readPackagesCallback('github', 'code-2', 'state-2');

        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe(
            'https://api.example/oauth/github/callback/plugins/read-packages?code=code-2&state=state-2',
        );
        const sent = new Headers(init?.headers);
        expect(sent.get(API_SCOPE_HEADER)).toBe('@personal');
        expect(sent.get('cookie')).toBe('ew_oauth_state=state-2');
    });

    it('connectCallback without a state still opts into personal scope', async () => {
        await oauthAPI.connectCallback('github', 'code-3');

        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('https://api.example/oauth/github/callback/plugins?code=code-3');
        expect(new Headers(init?.headers).get(API_SCOPE_HEADER)).toBe('@personal');
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for `connectProvider` — pins the C-03 state round-trip
 * contract on the web side:
 *
 *   1. `connectProvider` does NOT mint a local state.
 *   2. It calls `authAPI.getOAuthAuthUrl(providerId)` (no second arg).
 *   3. It sets `oauth_state` to the EXACT value the API returned.
 *   4. It returns `{ success, url }` with the API's url.
 *
 * The bug this test catches: web mints state A, API mints state B,
 * callback URL has B, cookie has A → "Invalid authorization state."
 */

// Hoisted because vi.mock factory runs before regular module code.
const { setOAuthStateCookieMock, getOAuthAuthUrlMock } = vi.hoisted(() => ({
    setOAuthStateCookieMock: vi.fn(),
    getOAuthAuthUrlMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    setOAuthStateCookie: setOAuthStateCookieMock,
    // unused by connectProvider but exported by the barrel
    removeAuthAccessCookies: vi.fn(),
    setAuthCookies: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
    authAPI: {
        getOAuthAuthUrl: getOAuthAuthUrlMock,
        // satisfy the import — connectProvider only touches getOAuthAuthUrl
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
    },
}));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({
    redirect: vi.fn(),
}));

describe('connectProvider — C-03 state round-trip', () => {
    beforeEach(() => {
        setOAuthStateCookieMock.mockReset();
        getOAuthAuthUrlMock.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('mirrors the API-returned state into the oauth_state cookie and returns the API url', async () => {
        getOAuthAuthUrlMock.mockResolvedValue({
            url: 'https://accounts.google.com/o/oauth2/v2/auth?state=SERVER_MINTED&client_id=x',
            state: 'SERVER_MINTED',
        });

        const { connectProvider } = await import('./auth');
        const { OAuthProvider } = await import('@/lib/api/enums');

        const result = await connectProvider(OAuthProvider.GOOGLE);

        // The API client is called with ONLY the providerId — no client-side
        // state. (The bug was passing a locally-minted state here.)
        expect(getOAuthAuthUrlMock).toHaveBeenCalledTimes(1);
        expect(getOAuthAuthUrlMock).toHaveBeenCalledWith(OAuthProvider.GOOGLE);

        // The cookie is set to EXACTLY the state the API returned.
        expect(setOAuthStateCookieMock).toHaveBeenCalledTimes(1);
        expect(setOAuthStateCookieMock).toHaveBeenCalledWith('SERVER_MINTED');

        expect(result).toEqual({
            success: true,
            url: 'https://accounts.google.com/o/oauth2/v2/auth?state=SERVER_MINTED&client_id=x',
        });
    });

    it('does not set the cookie when the API call fails', async () => {
        getOAuthAuthUrlMock.mockRejectedValue(new Error('upstream OAuth not configured'));

        const { connectProvider } = await import('./auth');
        const { OAuthProvider } = await import('@/lib/api/enums');

        const result = await connectProvider(OAuthProvider.GITHUB);

        expect(setOAuthStateCookieMock).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result).toMatchObject({ success: false });
    });

    it('cookie value equals the state query param in the returned url (defense against future drift)', async () => {
        // If a future refactor ever decouples the body `state` from the URL's
        // `?state=…`, login breaks again. Pin them with one assertion.
        const minted = 'A'.repeat(43); // base64url-ish width like randomBytes(32)
        getOAuthAuthUrlMock.mockResolvedValue({
            url: `https://github.com/login/oauth/authorize?state=${minted}&client_id=x`,
            state: minted,
        });

        const { connectProvider } = await import('./auth');
        const { OAuthProvider } = await import('@/lib/api/enums');
        const result = await connectProvider(OAuthProvider.GITHUB);

        const cookieValue = setOAuthStateCookieMock.mock.calls[0][0];
        const urlState = new URL(result.url!).searchParams.get('state');
        expect(cookieValue).toBe(urlState);
        expect(cookieValue).toBe(minted);
    });
});

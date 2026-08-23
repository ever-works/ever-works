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
const {
    setOAuthStateCookieMock,
    setAuthCookiesMock,
    getOAuthAuthUrlMock,
    getLoginDefaultWorkspaceHrefMock,
    getRedirectUrlMock,
    loginMock,
    redirectMock,
} = vi.hoisted(() => ({
    setOAuthStateCookieMock: vi.fn(),
    setAuthCookiesMock: vi.fn(),
    getOAuthAuthUrlMock: vi.fn(),
    getLoginDefaultWorkspaceHrefMock: vi.fn(),
    getRedirectUrlMock: vi.fn(),
    loginMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    setOAuthStateCookie: setOAuthStateCookieMock,
    // unused by connectProvider but exported by the barrel
    removeAuthAccessCookies: vi.fn(),
    setAuthCookies: setAuthCookiesMock,
}));

vi.mock('@/lib/api', () => ({
    authAPI: {
        getOAuthAuthUrl: getOAuthAuthUrlMock,
        login: loginMock,
        register: vi.fn(),
        logout: vi.fn(),
    },
    getLoginDefaultWorkspaceHref: getLoginDefaultWorkspaceHrefMock,
}));

vi.mock('@/lib/auth/redirect', () => ({ getRedirectUrl: getRedirectUrlMock }));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({
    redirect: redirectMock,
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

/**
 * `login` error mapping.
 *
 * The catch distinguished only `suspended`; every other rejection collapsed to
 * `invalidCredentials`. So a user whose address is unconfirmed — whose email and
 * password are CORRECT — was told "Invalid email or password" and pointed at
 * "Forgot password?", which cannot fix an unverified address. Observed live on
 * app.ever.works: the API answered `403 { message: 'Email not verified' }` while
 * the form said the credentials were wrong.
 *
 * `getTranslations` is mocked to echo its key, so each branch is identifiable by
 * the key it returns rather than by prose that may be re-worded.
 */
describe('login — which failure the user is told about', () => {
    beforeEach(() => {
        loginMock.mockReset();
        setAuthCookiesMock.mockReset();
        getLoginDefaultWorkspaceHrefMock.mockReset().mockResolvedValue('/');
        getRedirectUrlMock.mockReset().mockImplementation(async (_auth, href) => href);
        redirectMock.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

    /** The API's real rejection shape for an unconfirmed address. */
    function emailNotVerifiedRejection() {
        const err = new Error('Email not verified') as Error & { statusCode?: number };
        err.statusCode = 403;
        return err;
    }

    it('names the unverified email instead of blaming the credentials', async () => {
        loginMock.mockRejectedValue(emailNotVerifiedRejection());

        const { login } = await import('./auth');
        const result = await login('someone@example.com', 'correct-horse', null);

        expect(result).toEqual({ success: false, error: 'emailNotVerified' });
    });

    it('still blames the credentials when they are genuinely wrong', async () => {
        // Control: the mapping must stay narrow. If this also returned
        // `emailNotVerified`, the first test would pass for the wrong reason.
        const err = new Error('Invalid credentials') as Error & { statusCode?: number };
        err.statusCode = 401;
        loginMock.mockRejectedValue(err);

        const { login } = await import('./auth');
        const result = await login('someone@example.com', 'wrong', null);

        expect(result).toEqual({ success: false, error: 'invalidCredentials' });
    });

    it('still reports a suspended account', async () => {
        loginMock.mockRejectedValue(new Error('This account has been suspended'));

        const { login } = await import('./auth');
        const result = await login('someone@example.com', 'correct-horse', null);

        expect(result).toEqual({ success: false, error: 'account.suspended' });
    });

    it('does not mistake an unrelated 403 for an unverified email', async () => {
        const err = new Error('Forbidden: region blocked') as Error & { statusCode?: number };
        err.statusCode = 403;
        loginMock.mockRejectedValue(err);

        const { login } = await import('./auth');
        const result = await login('someone@example.com', 'correct-horse', null);

        expect(result).toEqual({ success: false, error: 'invalidCredentials' });
    });

    it('uses the persisted Organization only as the fresh-login navigation default', async () => {
        loginMock.mockResolvedValue({ access_token: 'token', user: {} });
        getLoginDefaultWorkspaceHrefMock.mockResolvedValue('/org/ever/dashboard');

        const { login } = await import('./auth');
        await login('someone@example.com', 'correct-horse', null);

        expect(getLoginDefaultWorkspaceHrefMock).toHaveBeenCalledTimes(1);
        expect(getRedirectUrlMock).toHaveBeenCalledWith(
            expect.objectContaining({ access_token: 'token' }),
            '/org/ever/dashboard',
        );
        expect(redirectMock).toHaveBeenCalledWith({
            locale: 'en',
            href: '/org/ever/dashboard',
        });
    });

    it('does not let the mutable preference override an explicit login redirect', async () => {
        loginMock.mockResolvedValue({ access_token: 'token', user: {} });

        const { login } = await import('./auth');
        await login('someone@example.com', 'correct-horse', '/missions');

        expect(getLoginDefaultWorkspaceHrefMock).not.toHaveBeenCalled();
        expect(getRedirectUrlMock).not.toHaveBeenCalled();
        expect(redirectMock).toHaveBeenCalledWith({ locale: 'en', href: '/missions' });
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EW-070 — the signed-out resend action, and EW-082 — the reset-password
 * failure messages it sits next to.
 *
 * What matters here is that `requestVerificationEmail` posts to the PUBLIC
 * endpoint (not the session-guarded one an unverified user can never reach)
 * and that it does not invent a distinction the server refuses to make.
 */

const { resendVerificationMock, resetPasswordMock, getTranslationsMock } = vi.hoisted(() => ({
    resendVerificationMock: vi.fn(),
    resetPasswordMock: vi.fn(),
    getTranslationsMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    setOAuthStateCookie: vi.fn(),
    removeAuthAccessCookies: vi.fn(),
    setAuthCookies: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
    authAPI: {
        resendVerification: resendVerificationMock,
        resetPassword: resetPasswordMock,
        getOAuthAuthUrl: vi.fn(),
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
    },
}));

vi.mock('next-intl/server', () => ({
    // Namespaced translator: returns `${namespace}.${key}` so assertions can
    // prove WHICH message key was chosen, which is the whole point of EW-082.
    getTranslations: (namespace?: string) =>
        Promise.resolve((key: string) => (namespace ? `${namespace}.${key}` : key)),
    getLocale: async () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({
    redirect: vi.fn(),
}));

/** Mirrors `ApiResponseError` (message + statusCode) without importing 'server-only'. */
function apiError(message: string, statusCode: number): Error {
    const err = new Error(message) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
}

describe('requestVerificationEmail — EW-070 signed-out resend', () => {
    beforeEach(() => {
        resendVerificationMock.mockReset();
        getTranslationsMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('posts to the PUBLIC resend endpoint, not the session-guarded one', async () => {
        resendVerificationMock.mockResolvedValue({ message: 'ok' });
        const { requestVerificationEmail } = await import('./auth');

        const result = await requestVerificationEmail('user@example.com');

        // `authAPI.sendVerification` is the authenticated route and is
        // unreachable for the users this feature exists for — assert we did
        // NOT go there by asserting we went here, with the email in the body.
        expect(resendVerificationMock).toHaveBeenCalledTimes(1);
        expect(resendVerificationMock.mock.calls[0][0]).toMatchObject({
            email: 'user@example.com',
        });
        expect(result.success).toBe(true);
    });

    it('sends a verification callback URL so the emailed link lands on the verify route', async () => {
        resendVerificationMock.mockResolvedValue({ message: 'ok' });
        const { requestVerificationEmail } = await import('./auth');

        await requestVerificationEmail('user@example.com');

        const body = resendVerificationMock.mock.calls[0][0];
        expect(body.emailVerificationCallbackUrl).toContain('/api/auth/verify-email');
    });

    it('rejects a malformed address before touching the API', async () => {
        const { requestVerificationEmail } = await import('./auth');

        const result = await requestVerificationEmail('not-an-email');

        expect(result.success).toBe(false);
        expect(resendVerificationMock).not.toHaveBeenCalled();
    });

    it('returns a generic translated failure and never forwards the raw upstream message', async () => {
        resendVerificationMock.mockRejectedValue(
            apiError('ECONNREFUSED 10.42.0.7:3000 postgres pool exhausted', 500),
        );
        const { requestVerificationEmail } = await import('./auth');

        const result = await requestVerificationEmail('user@example.com');

        expect(result.success).toBe(false);
        expect(result.error).toBe('api.errors.resendVerificationFailed');
        // Infra detail must not reach the browser.
        expect(result.error).not.toContain('ECONNREFUSED');
        expect(result.error).not.toContain('postgres');
    });

    it('does not branch on the response body — the server returns one body for every outcome', async () => {
        // Unknown address and real address get the same API body by design.
        // Whatever comes back, the action reports the same success shape, so
        // the UI cannot leak account existence.
        resendVerificationMock.mockResolvedValue({ message: 'anything at all' });
        const { requestVerificationEmail } = await import('./auth');

        const a = await requestVerificationEmail('unknown@example.com');
        const b = await requestVerificationEmail('known@example.com');

        expect(a).toEqual(b);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});

describe('resetPassword — EW-082 distinguishes the failure modes', () => {
    beforeEach(() => {
        resetPasswordMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    const VALID_PASSWORD = 'newsecret1';

    it('an EXPIRED link gets the expired message and offers a new link', async () => {
        resetPasswordMock.mockRejectedValue(apiError('Reset token expired', 400));
        const { resetPassword } = await import('./auth');

        const result = await resetPassword('tok', VALID_PASSWORD);

        expect(result.success).toBe(false);
        expect(result.error).toBe('auth.resetPassword.errors.expiredToken');
        expect(result.linkIsDead).toBe(true);
    });

    it('an ALREADY-USED / invalid link gets the invalid message and offers a new link', async () => {
        resetPasswordMock.mockRejectedValue(apiError('Invalid reset token', 400));
        const { resetPassword } = await import('./auth');

        const result = await resetPassword('tok', VALID_PASSWORD);

        expect(result.error).toBe('auth.resetPassword.errors.invalidToken');
        expect(result.linkIsDead).toBe(true);
    });

    it('a THROTTLED submit does NOT tell the user their link is dead', async () => {
        resetPasswordMock.mockRejectedValue(apiError('ThrottlerException: Too Many Requests', 429));
        const { resetPassword } = await import('./auth');

        const result = await resetPassword('tok', VALID_PASSWORD);

        expect(result.error).toBe('auth.resetPassword.errors.rateLimited');
        // The token was never consumed — sending this user off to request a
        // new link would be wrong advice, and lands them in the same throttle.
        expect(result.linkIsDead).toBe(false);
    });

    it('an UPSTREAM failure says try again, and does not blame the link', async () => {
        resetPasswordMock.mockRejectedValue(apiError('Internal server error', 500));
        const { resetPassword } = await import('./auth');

        const result = await resetPassword('tok', VALID_PASSWORD);

        expect(result.error).toBe('auth.resetPassword.errors.upstream');
        expect(result.linkIsDead).toBe(false);
    });

    it('the four failures produce four DIFFERENT messages — the old behaviour was one for all', async () => {
        const { resetPassword } = await import('./auth');

        const messages: string[] = [];
        for (const err of [
            apiError('Reset token expired', 400),
            apiError('Invalid reset token', 400),
            apiError('ThrottlerException', 429),
            apiError('Internal server error', 500),
        ]) {
            resetPasswordMock.mockRejectedValueOnce(err);
            const r = await resetPassword('tok', VALID_PASSWORD);
            messages.push(String(r.error));
        }

        expect(new Set(messages).size).toBe(4);
    });
});

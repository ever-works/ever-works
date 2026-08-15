import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EW-078 / EW-079 — the email-verification callback route.
 *
 * Two defects, both on the failure path:
 *
 *   EW-078  Every rejection was reported as `verify_email_invalid_token`
 *           ("invalid or has already been used"), including an expired link.
 *           `verify_email_expired_token` existed, was translated into all 21
 *           locales, was wired into the error page's switch — and was
 *           unreachable.
 *
 *   EW-079  The failure path fell through to `getRedirectUrl`, which returns
 *           the `redirect_url` cookie in place of the href it is handed. With
 *           a redirect cookie set, a failed verification silently landed the
 *           user on their original destination and showed them nothing.
 */

const { verifyEmailMock, setAuthCookiesMock, getRedirectUrlMock, redirectMock } = vi.hoisted(
    () => ({
        verifyEmailMock: vi.fn(),
        setAuthCookiesMock: vi.fn(),
        getRedirectUrlMock: vi.fn(),
        redirectMock: vi.fn(),
    }),
);

vi.mock('@/lib/api', () => ({
    authAPI: { verifyEmail: verifyEmailMock },
}));

vi.mock('@/lib/auth', () => ({
    setAuthCookies: setAuthCookiesMock,
}));

vi.mock('@/lib/auth/redirect', () => ({
    getRedirectUrl: getRedirectUrlMock,
}));

vi.mock('@/i18n/navigation', () => ({
    redirect: redirectMock,
}));

vi.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
}));

/** The `ApiResponseError` shape `serverFetch` actually throws. */
class FakeApiResponseError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
    ) {
        super(message);
        this.name = 'ApiResponseError';
    }
}

function requestWith(token: string | null) {
    const url = new URL('https://app.ever.works/api/auth/verify-email');
    if (token !== null) url.searchParams.set('token', token);
    return { nextUrl: url } as unknown as import('next/server').NextRequest;
}

/** The `?error=` code the route redirected to, or null if it went elsewhere. */
function redirectedErrorCode(): string | null {
    expect(redirectMock).toHaveBeenCalledTimes(1);
    const href: string = redirectMock.mock.calls[0][0].href;
    return new URL(href, 'https://app.ever.works').searchParams.get('error');
}

describe('GET /api/auth/verify-email', () => {
    beforeEach(() => {
        verifyEmailMock.mockReset();
        setAuthCookiesMock.mockReset();
        getRedirectUrlMock.mockReset();
        redirectMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    describe('EW-078 — the rejection is classified, not assumed', () => {
        it('routes an EXPIRED token to verify_email_expired_token', async () => {
            // The API's own wording: auth.service.ts#verifyEmail throws
            // BadRequestException('Verification token expired').
            verifyEmailMock.mockRejectedValue(
                new FakeApiResponseError('Verification token expired', 400),
            );

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            expect(redirectedErrorCode()).toBe('verify_email_expired_token');
        });

        it('still routes a genuinely unknown token to verify_email_invalid_token', async () => {
            verifyEmailMock.mockRejectedValue(
                new FakeApiResponseError('Invalid verification token', 400),
            );

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            expect(redirectedErrorCode()).toBe('verify_email_invalid_token');
        });

        it('routes an API outage to verify_email_failed, not a verdict on the token', async () => {
            verifyEmailMock.mockRejectedValue(
                new FakeApiResponseError('Internal server error', 503),
            );

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            expect(redirectedErrorCode()).toBe('verify_email_failed');
        });

        it('routes a transport failure (no status) to verify_email_failed', async () => {
            verifyEmailMock.mockRejectedValue(new TypeError('fetch failed'));

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            expect(redirectedErrorCode()).toBe('verify_email_failed');
        });

        it('still reports a missing token as verify_email_missing_token', async () => {
            const { GET } = await import('./route');
            await GET(requestWith(null));

            expect(redirectedErrorCode()).toBe('verify_email_missing_token');
            expect(verifyEmailMock).not.toHaveBeenCalled();
        });
    });

    describe('EW-079 — a failure is never redirected away from the error page', () => {
        it('does not consult the redirect cookie when verification fails', async () => {
            // A redirect cookie IS set and points somewhere valid. Before the
            // fix this value replaced the error href and the user saw nothing.
            getRedirectUrlMock.mockResolvedValue('/dashboard/works/42');
            verifyEmailMock.mockRejectedValue(
                new FakeApiResponseError('Verification token expired', 400),
            );

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            // The redirect helper is not even called, so the cookie survives
            // for the retry after the user requests a fresh link.
            expect(getRedirectUrlMock).not.toHaveBeenCalled();

            const href: string = redirectMock.mock.calls[0][0].href;
            expect(href).toContain('/auth/error');
            expect(href).not.toContain('/dashboard/works/42');
        });

        it('does not mint a session when verification fails', async () => {
            verifyEmailMock.mockRejectedValue(
                new FakeApiResponseError('Invalid verification token', 400),
            );

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            expect(setAuthCookiesMock).not.toHaveBeenCalled();
        });

        it('DOES honour the redirect cookie on success (the behaviour worth keeping)', async () => {
            verifyEmailMock.mockResolvedValue({
                access_token: 'tok-123',
                user: { id: 'u1', username: 'a', email: 'a@b.c', emailVerified: true },
            });
            getRedirectUrlMock.mockResolvedValue('/dashboard/works/42?session=tok-123');

            const { GET } = await import('./route');
            await GET(requestWith('a'.repeat(64)));

            expect(setAuthCookiesMock).toHaveBeenCalledWith('tok-123');
            // Called with the real auth response, so the session token gets
            // stitched into the stored destination as designed.
            expect(getRedirectUrlMock).toHaveBeenCalledTimes(1);
            expect(getRedirectUrlMock.mock.calls[0][0]).toMatchObject({ access_token: 'tok-123' });
            const { ROUTES } = await import('@/lib/constants');
            expect(getRedirectUrlMock.mock.calls[0][1]).toBe(ROUTES.DASHBOARD + '?verified=true');
            expect(redirectMock.mock.calls[0][0].href).toBe('/dashboard/works/42?session=tok-123');
        });
    });
});

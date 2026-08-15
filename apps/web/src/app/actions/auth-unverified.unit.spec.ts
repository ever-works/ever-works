import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EW-077 / EW-080 — the two server actions that mint a session for an address
 * nobody has confirmed yet.
 *
 *   EW-077  `register` signs the new user straight into the app. The account
 *           works until the session ends, and then the password gate refuses
 *           them for the first time — a rule that was in force from the first
 *           second, surfacing days later as what looks like a new failure.
 *
 *   EW-080  `redeemMagicLink` admits a user the password tab would turn away.
 *           That asymmetry is intended (the mailed link IS the ownership
 *           proof), but the API does not flip `emailVerified`, so the password
 *           tab keeps refusing the same person with nothing anywhere
 *           connecting the two.
 *
 * Both are fixed the same way: carry the true state to the landing page.
 */

const {
    registerMock,
    redeemMagicLinkApiMock,
    setAuthCookiesMock,
    getRedirectUrlMock,
    redirectMock,
} = vi.hoisted(() => ({
    registerMock: vi.fn(),
    redeemMagicLinkApiMock: vi.fn(),
    setAuthCookiesMock: vi.fn(),
    getRedirectUrlMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
    authAPI: {
        register: registerMock,
        redeemMagicLink: redeemMagicLinkApiMock,
        login: vi.fn(),
        logout: vi.fn(),
        getOAuthAuthUrl: vi.fn(),
    },
}));

vi.mock('@/lib/auth', () => ({
    setAuthCookies: setAuthCookiesMock,
    removeAuthAccessCookies: vi.fn(),
    setOAuthStateCookie: vi.fn(),
}));

vi.mock('@/lib/auth/redirect', () => ({ getRedirectUrl: getRedirectUrlMock }));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({ redirect: redirectMock }));

const VALID_TERMS = [
    {
        documentId: 'tos',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        locale: 'en',
    },
];

function authResponse(emailVerified: boolean | undefined) {
    return {
        access_token: 'tok-1',
        user: {
            id: 'u1',
            username: 'someone',
            email: 'someone@example.com',
            ...(emailVerified === undefined ? {} : { emailVerified }),
        },
    };
}

/** The href the action redirected to. */
function redirectedHref(): string {
    expect(redirectMock).toHaveBeenCalledTimes(1);
    return redirectMock.mock.calls[0][0].href;
}

function noticeParam(href: string): string | null {
    return new URL(href, 'https://app.ever.works').searchParams.get('verifyEmail');
}

describe('EW-077 — register tells the user the address is unconfirmed', () => {
    beforeEach(() => {
        registerMock.mockReset();
        setAuthCookiesMock.mockReset();
        redirectMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('flags the landing page when the new account is unconfirmed', async () => {
        registerMock.mockResolvedValue(authResponse(false));

        const { register } = await import('./auth');
        await register('someone', 'someone@example.com', 'password1', VALID_TERMS);

        const href = redirectedHref();
        expect(noticeParam(href)).toBe('required');
        // The existing new-user onboarding signal must survive — it drives the
        // welcome toast and the dashboard's first-run proposal kick.
        expect(new URL(href, 'https://x.invalid').searchParams.get('newUser')).toBe('true');
    });

    it('stays quiet when the deployment does not require verification', async () => {
        // REQUIRE_EMAIL_VERIFICATION=false, or an already-confirmed account:
        // nagging about a gate that is switched off is its own dishonesty.
        registerMock.mockResolvedValue(authResponse(true));

        const { register } = await import('./auth');
        await register('someone', 'someone@example.com', 'password1', VALID_TERMS);

        expect(noticeParam(redirectedHref())).toBeNull();
    });

    it('stays quiet when the API omits the field entirely', async () => {
        registerMock.mockResolvedValue(authResponse(undefined));

        const { register } = await import('./auth');
        await register('someone', 'someone@example.com', 'password1', VALID_TERMS);

        expect(noticeParam(redirectedHref())).toBeNull();
    });

    it('does not redirect at all when registration fails', async () => {
        registerMock.mockRejectedValue(new Error('email already exists'));

        const { register } = await import('./auth');
        const result = await register('someone', 'someone@example.com', 'password1', VALID_TERMS);

        expect(result.success).toBe(false);
        expect(redirectMock).not.toHaveBeenCalled();
    });
});

describe('EW-080 — a magic-link sign-in says the address is still unconfirmed', () => {
    beforeEach(() => {
        redeemMagicLinkApiMock.mockReset();
        setAuthCookiesMock.mockReset();
        getRedirectUrlMock.mockReset();
        redirectMock.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('still signs the unconfirmed user in — the bypass is intended, not a bug', async () => {
        // Redeeming a link that only ever existed inside that mailbox IS proof
        // of ownership. Refusing here would break the recovery path for exactly
        // the people the password gate has locked out.
        redeemMagicLinkApiMock.mockResolvedValue(authResponse(false));
        getRedirectUrlMock.mockImplementation(async (_r: unknown, href: string) => href);

        const { redeemMagicLink } = await import('./auth');
        const result = await redeemMagicLink('a'.repeat(64), null);

        expect(setAuthCookiesMock).toHaveBeenCalledWith('tok-1');
        expect(result).toEqual({ success: true });
    });

    it('flags the landing page so the disagreement with the password tab is not silent', async () => {
        redeemMagicLinkApiMock.mockResolvedValue(authResponse(false));
        getRedirectUrlMock.mockImplementation(async (_r: unknown, href: string) => href);

        const { redeemMagicLink } = await import('./auth');
        await redeemMagicLink('a'.repeat(64), null);

        expect(noticeParam(redirectedHref())).toBe('required');
    });

    it('stays quiet for a confirmed account', async () => {
        redeemMagicLinkApiMock.mockResolvedValue(authResponse(true));
        getRedirectUrlMock.mockImplementation(async (_r: unknown, href: string) => href);

        const { redeemMagicLink } = await import('./auth');
        await redeemMagicLink('a'.repeat(64), null);

        expect(noticeParam(redirectedHref())).toBeNull();
    });

    it('does not decorate an allowlisted absolute redirect target', async () => {
        // `ALLOWED_REDIRECT_URLS` defaults to `localhost,127.0.0.1`, so this is
        // a host the redirect guard actually honours. An external page has no
        // idea what `verifyEmail` means, so the param must not travel off-site.
        redeemMagicLinkApiMock.mockResolvedValue(authResponse(false));
        getRedirectUrlMock.mockImplementation(async (_r: unknown, href: string) => href);

        const { redeemMagicLink } = await import('./auth');
        await redeemMagicLink('a'.repeat(64), 'http://localhost:3000/welcome');

        expect(redirectedHref()).toBe('http://localhost:3000/welcome');
    });

    it('does not redirect at all when redemption fails', async () => {
        redeemMagicLinkApiMock.mockRejectedValue(new Error('Invalid magic link'));

        const { redeemMagicLink } = await import('./auth');
        const result = await redeemMagicLink('a'.repeat(64), null);

        expect(result.success).toBe(false);
        expect(redirectMock).not.toHaveBeenCalled();
        expect(setAuthCookiesMock).not.toHaveBeenCalled();
    });
});

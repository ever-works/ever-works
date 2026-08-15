'use server';

import { z } from 'zod';
import { removeAuthAccessCookies, setOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { ALLOWED_REDIRECT_URLS, ROUTES, withAppUrl } from '@/lib/constants';
import { VALIDATION_RULES } from './validation';
import { authAPI, AuthResponse, type TermsAcceptanceClaim } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isValidRedirectUrl } from '@/lib/utils';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { isEmailUnconfirmed, withUnverifiedEmailNotice } from '@/lib/auth/unverified-email';
import { OAuthProvider } from '@/lib/api/enums';

// Security: `isValidRedirectUrl` only validates URL *syntax* — it accepts any
// absolute http(s) URL regardless of host, which is an open redirect: an
// attacker-supplied `?redirect=https://evil.com` query param would otherwise be
// used as the post-login / post-magic-link redirect target (phishing). Restrict
// absolute redirects to hosts in the server-side allowlist (relative paths are
// already constrained by `isValidRedirectUrl`). Host matching mirrors
// `isRelativeOrAllowedRedirectHost` in lib/auth/redirect.ts and
// `isRedirectAllowedWithSession` in lib/utils/url.ts (exact match + leading
// `*.` wildcard).
function isRelativeOrAllowedRedirectHost(redirectUrl: string): boolean {
    if (redirectUrl.startsWith('/')) {
        return true;
    }

    try {
        const hostname = new URL(redirectUrl).hostname.toLowerCase();

        return ALLOWED_REDIRECT_URLS.some((allowed) => {
            const cleanAllowed = allowed
                .replace(/^https?:\/\//, '')
                .toLowerCase()
                .trim();

            if (cleanAllowed.startsWith('*.')) {
                const domain = cleanAllowed.slice(2);
                return hostname !== domain && hostname.endsWith('.' + domain);
            }

            return hostname === cleanAllowed;
        });
    } catch {
        return false;
    }
}

/**
 * Does this rejection mean "the credentials were right, the address is not
 * confirmed"? The API answers `403 { message: 'Email not verified' }`.
 *
 * Matched on the status AND the message so a future unrelated 403 on this
 * route doesn't silently start telling people to check their inbox. The
 * message check is tolerant of case and wording drift around the two words
 * that carry the meaning.
 */
function isEmailNotVerifiedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const looksUnverified = /email.*not.*verif/i.test(message);
    if (!looksUnverified) return false;

    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    return statusCode === undefined || statusCode === 403;
}

/**
 * Does this rejection mean "the account is in a lockout window"?
 *
 * Matched on the wording the API actually emits (auth-provider.service.ts
 * `buildLockoutMessage`: "Account temporarily locked due to too many failed
 * login attempts, try again in N minutes"). Kept narrow, on the words that
 * carry the meaning, so an unrelated future rejection cannot start claiming a
 * lockout — the same discipline as the sibling above.
 */
function isAccountLockedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /account .*lock|temporarily locked/i.test(message);
}

export async function login(identifier: string, password: string, redirectUrl: string | null) {
    const t = await getTranslations('validation.auth');
    // `validation.auth` has no key for an unverified email; the message already
    // exists (and is already translated into all 21 locales) under `auth.error`.
    const tAuthError = await getTranslations('auth.error');

    // Validation schemas
    const loginSchema = z.object({
        email: z.string().min(1, t('email.required')),
        password: z.string().min(1, t('password.required')),
    });

    // Validate input
    const validation = loginSchema.safeParse({ email: identifier, password });
    if (!validation.success) {
        return {
            success: false,
            error: validation.error.errors[0].message,
        };
    }

    let authResponse: AuthResponse | null = null;
    let href: string = ROUTES.DASHBOARD;

    try {
        authResponse = await authAPI.login({
            email: validation.data.email,
            password: validation.data.password,
        });

        await setAuthCookies(authResponse.access_token);
    } catch (error) {
        console.error(error);

        // Only `suspended` was ever distinguished, so every other rejection —
        // including the API's `403 Email not verified` — was reported as
        // "Invalid email or password". That is not merely vague, it is wrong:
        // the credentials ARE correct, and the message sends the user to
        // "Forgot password?" to fix a problem a password reset cannot fix.
        // Tell them what actually happened so the next step is the right one.
        let message = t('invalidCredentials');
        if (error instanceof Error && error.message.includes('suspended')) {
            message = t('account.suspended');
        } else if (isEmailNotVerifiedError(error)) {
            message = tAuthError('emailNotVerified');
        } else if (isAccountLockedError(error)) {
            // Same defect the comment above describes, still open for the
            // lockout case: the API sends a precise, actionable message —
            // "Account temporarily locked …, try again in N minutes" — and it
            // fell through to "Invalid email or password". The credentials may
            // well be RIGHT, and the suggested fix ("Forgot password?") cannot
            // clear a time-based lock. Pass the server's own wording through so
            // the countdown survives; the generic locked string is the fallback
            // if the API ever stops including it.
            message =
                error instanceof Error && error.message
                    ? error.message
                    : tAuthError('accountLocked');
        }

        return {
            success: false,
            error: message,
        };
    }

    // Security: require BOTH a syntactically valid URL AND a relative path or
    // allowlisted host before honoring the query-param redirect target, closing
    // the open redirect (an absolute `?redirect=https://evil.com` is rejected).
    if (
        redirectUrl &&
        isValidRedirectUrl(redirectUrl) &&
        isRelativeOrAllowedRedirectHost(redirectUrl)
    ) {
        href = redirectUrl;
    } else if (authResponse) {
        // Check if we have a redirect URL in a cookie
        href = await getRedirectUrl(authResponse, href);
    }

    redirect({ locale: await getLocale(), href });

    return {
        success: true,
    };
}

export async function register(
    username: string,
    email: string,
    password: string,
    /**
     * The legal documents the user ticked the box for, exactly as the form
     * displayed them.
     *
     * This parameter is the missing link in the chain the terms checkbox never
     * travelled: the input was uncontrolled, so it never entered `formData`,
     * so this action never saw it, so `authAPI.register` never sent it, so
     * nothing was ever recorded.
     */
    terms: TermsAcceptanceClaim[] = [],
) {
    const t = await getTranslations('validation.auth');

    const termsClaimSchema = z.object({
        documentId: z.string().min(1),
        version: z.string().min(1),
        // Shape only — the API is what checks the digest against the published
        // corpus. Validating it twice against a client-side copy would just be
        // a second place to drift.
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        locale: z.string().min(1),
    });

    const registerSchema = z.object({
        username: z
            .string()
            .min(
                VALIDATION_RULES.USERNAME_MIN_LENGTH,
                t('username.minLength', { length: VALIDATION_RULES.USERNAME_MIN_LENGTH }),
            ),
        email: z.string().email(t('email.invalid')),
        password: z
            .string()
            .min(8, t('password.minLength', { length: 8 }))
            .regex(/[a-z]/, t('password.lowercase'))
            .regex(/(\d|\W)/, t('password.numberOrSpecial'))
            .regex(/^[^.\n]/, t('password.cannotStartWith')),
        terms: z.array(termsClaimSchema).min(1, t('terms.required')),
    });

    // Validate input
    const validation = registerSchema.safeParse({ username, email, password, terms });
    if (!validation.success) {
        return {
            success: false,
            error: validation.error.errors[0].message,
        };
    }

    let authResponse: AuthResponse | null = null;

    try {
        authResponse = await authAPI.register({
            username: validation.data.username,
            email: validation.data.email,
            password: validation.data.password,
            terms: validation.data.terms,
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });

        await setAuthCookies(authResponse.access_token);
    } catch (error) {
        console.error(error);

        const errorT = await getTranslations('api.errors');
        let message = errorT('registerFailed');

        // Security: only map the known "already exists" case to a friendly
        // message; never forward the raw upstream `error.message` to the client
        // (it can leak DB/infra detail). All other errors fall through to the
        // generic `registerFailed` message assigned above.
        if (error instanceof Error && error.message.includes('exists')) {
            message = t('email.emailAlreadyRegistered');
        }

        return {
            success: false,
            error: message,
        };
    }

    // EW-077: registration signs the new user in immediately, so the account
    // works right now — and stops working the moment this session ends, when
    // the password gate (`requireEmailVerification`, H-07) starts refusing
    // them with "Please verify your email address before signing in". Nothing
    // used to mark that difference, so a restriction that applied from the
    // first second surfaced days later looking like a fresh breakage, on a
    // page that gives no hint the two things are connected.
    //
    // Rather than gate here — which would throw away the working session the
    // API deliberately issued, and take the new-user onboarding on the
    // dashboard with it — say what is true: you are in, the address is not
    // confirmed yet, here is what happens if you leave it that way.
    //
    // Read from the response the API actually returned rather than assumed:
    // when `REQUIRE_EMAIL_VERIFICATION=false` (local dev, e2e) or the account
    // arrives already confirmed, `emailVerified` is not `false` and the notice
    // correctly stays quiet instead of nagging about a rule that isn't on.
    let href = ROUTES.DASHBOARD + '?newUser=true';
    if (isEmailUnconfirmed(authResponse?.user)) {
        href = withUnverifiedEmailNotice(href);
    }

    redirect({
        locale: await getLocale(),
        href,
    });

    return {
        success: true,
    };
}

export async function logout() {
    try {
        await authAPI.logout();
    } catch (error) {
        console.error(error);
    }

    await removeAuthAccessCookies();

    // Redirect to login page
    redirect({
        locale: await getLocale(),
        href: ROUTES.AUTH_LOGIN,
    });

    return {
        success: true,
    };
}

// =================
// OAuth
// =================

export async function connectProvider(providerId: OAuthProvider) {
    try {
        // C-03: the API server mints the OAuth `state` nonce and returns it.
        // We mirror it into a host-scoped `oauth_state` cookie on this
        // origin so `handleOAuthCallback` can validate the value the OAuth
        // provider echoes back on the callback. The OAuth provider's
        // `redirect_uri` points at the web app, so the API-side cookie
        // (set on a different origin) is not sent on the callback in the
        // normal user flow — this mirror is what closes the CSRF loop.
        const { url, state } = await authAPI.getOAuthAuthUrl(providerId);
        await setOAuthStateCookie(state);

        return {
            success: true,
            url,
        };
    } catch (error) {
        console.error(error);
        const t = await getTranslations('api.errors');

        // Security: return a generic translated message; never forward the raw
        // upstream `error.message` to the client (it can leak infra detail).
        return {
            success: false,
            error: t('providerConnectFailed'),
        };
    }
}

// =================
// Password Reset
// =================

export async function forgotPassword(email: string) {
    const t = await getTranslations('validation.auth');

    // Validation
    const emailSchema = z.string().email(t('email.invalid'));

    const validation = emailSchema.safeParse(email);
    if (!validation.success) {
        return {
            success: false,
            error: validation.error.errors[0].message,
        };
    }

    try {
        await authAPI.forgotPassword({
            email: validation.data,
            resetPasswordCallbackUrl: withAppUrl(ROUTES.API_AUTH_RESET_PASSWORD),
        });

        return {
            success: true,
            message: 'Password reset instructions sent to your email',
        };
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        // Security: return a generic translated message; never forward the raw
        // upstream `error.message` to the client (it can leak infra detail).
        return {
            success: false,
            error: errorT('forgotPasswordFailed'),
        };
    }
}

export async function resetPassword(token: string, newPassword: string) {
    const t = await getTranslations('validation.auth');

    // Validation
    const resetSchema = z.object({
        token: z.string().min(1, 'Token is required'),
        password: z
            .string()
            .min(8, t('password.minLength', { length: 8 }))
            .regex(/[a-z]/, t('password.lowercase'))
            .regex(/(\d|\W)/, t('password.numberOrSpecial'))
            .regex(/^[^.\n]/, t('password.cannotStartWith')),
    });

    const validation = resetSchema.safeParse({ token, password: newPassword });
    if (!validation.success) {
        return {
            success: false,
            error: validation.error.errors[0].message,
        };
    }

    try {
        await authAPI.resetPassword({
            token: validation.data.token,
            newPassword: validation.data.password,
        });
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        // Security: return a generic translated message; never forward the raw
        // upstream `error.message` to the client (it can leak infra detail).
        return {
            success: false,
            error: errorT('resetPasswordFailed'),
        };
    }

    redirect({
        locale: await getLocale(),
        href: ROUTES.AUTH_LOGIN + '?reset=true',
    });

    return {
        success: true,
    };
}

// =================
// Magic Link (EW-633)
// =================

/**
 * Issue a magic-link email. The API response is intentionally uniform
 * regardless of whether the email is registered (anti-enumeration), so
 * a successful call here only proves the request was accepted — not
 * that an email is on its way.
 */
export async function issueMagicLink(email: string) {
    const t = await getTranslations('validation.auth');

    const emailSchema = z.string().email(t('email.invalid'));
    const validation = emailSchema.safeParse(email);
    if (!validation.success) {
        return {
            success: false,
            error: validation.error.errors[0].message,
        };
    }

    try {
        await authAPI.requestMagicLink({
            email: validation.data,
            magicLinkCallbackUrl: withAppUrl(ROUTES.AUTH_MAGIC_LINK),
        });

        return { success: true };
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        // Security: return a generic translated message; never forward the raw
        // upstream `error.message` to the client (it can leak infra detail).
        return {
            success: false,
            error: errorT('magicLinkFailed'),
        };
    }
}

/**
 * Redeem a magic-link token. On success the session cookie is set and
 * the caller is redirected to the dashboard (or the requested
 * `redirectUrl`, when valid). On failure returns an error string so
 * the UI can render a "Send a new link" recovery path.
 *
 * ---
 * EW-080 — why this signs in a user the password tab would refuse.
 *
 * The two tabs on the login page apply different rules to the same account.
 * Password sign-in is gated on `emailVerified` (`requireEmailVerification`,
 * H-07): register with someone else's address and you must not get a session
 * out of it. Magic-link sign-in is not gated, and that is deliberate, not an
 * oversight in the gate.
 *
 * H-07 exists to stop an attacker turning "I typed this address" into a
 * session. A magic link cannot be used that way. `requestMagicLink` only ever
 * mints a token for an address already on an account, the raw token is never
 * returned in the HTTP response — it exists solely inside the email body —
 * and redemption is single-use with a 15-minute TTL. So holding a redeemable
 * token IS possession of the mailbox. That is the identical proof the
 * verification link provides; asking someone who just demonstrated it to go
 * demonstrate it again would be theatre, and it would break the recovery path
 * for exactly the users who need it: someone locked out by the password gate
 * can still get in through their inbox.
 *
 * So: intentional, and left as-is.
 *
 * What was NOT acceptable is that the disagreement was silent. The API does
 * not set `emailVerified` when a magic link is redeemed, so this session is
 * live while the account is still, on the record, unconfirmed — and the
 * password tab will keep refusing the same person, with no explanation
 * anywhere connecting the two. The notice below makes that state visible and
 * tells them the one action that clears it (the verification link in their
 * inbox); the magic-link tab on the login page states the rule up front.
 */
export async function redeemMagicLink(token: string, redirectUrl: string | null) {
    const t = await getTranslations('validation.auth');

    const tokenSchema = z.string().min(1, t('token.required'));
    const validation = tokenSchema.safeParse(token);
    if (!validation.success) {
        return {
            success: false,
            error: validation.error.errors[0].message,
        };
    }

    let authResponse: AuthResponse | null = null;
    let href: string = ROUTES.DASHBOARD;

    try {
        authResponse = await authAPI.redeemMagicLink({ token: validation.data });
        await setAuthCookies(authResponse.access_token);
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        // Security: return a generic translated message; never forward the raw
        // upstream `error.message` to the client (it can leak infra detail).
        return {
            success: false,
            error: errorT('magicLinkInvalid'),
        };
    }

    // Security: require BOTH a syntactically valid URL AND a relative path or
    // allowlisted host before honoring the query-param redirect target, closing
    // the open redirect (an absolute `?redirect=https://evil.com` is rejected).
    if (
        redirectUrl &&
        isValidRedirectUrl(redirectUrl) &&
        isRelativeOrAllowedRedirectHost(redirectUrl)
    ) {
        href = redirectUrl;
    } else if (authResponse) {
        href = await getRedirectUrl(authResponse, href);
    }

    // EW-080: signed in, but the address is still unconfirmed on the record —
    // so the password tab will refuse this same person next time. Say so.
    if (isEmailUnconfirmed(authResponse?.user)) {
        href = withUnverifiedEmailNotice(href);
    }

    redirect({ locale: await getLocale(), href });

    return { success: true };
}

// For oAuth connection check file:
// Check apps/web/src/app/auth/[provider]/callback/route.ts

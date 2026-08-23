'use server';

import { z } from 'zod';
import { removeAuthAccessCookies, setOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { ALLOWED_REDIRECT_URLS, ROUTES, withAppUrl } from '@/lib/constants';
import { PASSWORD_RULES, VALIDATION_RULES } from './validation';
import {
    authAPI,
    AuthResponse,
    getLoginDefaultWorkspaceHref,
    type TermsAcceptanceClaim,
} from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isValidRedirectUrl } from '@/lib/utils';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { isEmailUnconfirmed, withUnverifiedEmailNotice } from '@/lib/auth/unverified-email';
import { classifyResetPasswordError, resetLinkIsDead } from '@/lib/auth/reset-password-error';
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

/**
 * Workspace preference resolution is post-authentication navigation only.
 * Once the API has authenticated the user and the session cookie is written,
 * a stale preference, revoked membership, or transient scope lookup failure
 * must not turn that successful authentication into an action error.
 */
async function resolveLoginDefaultWorkspaceHref(): Promise<string> {
    try {
        return await getLoginDefaultWorkspaceHref();
    } catch (error) {
        console.error('Unable to resolve the login workspace default', error);
        return ROUTES.DASHBOARD;
    }
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
        // The mutable preference is navigation convenience only. Resolve it
        // once after authentication, then let an explicit redirect cookie win.
        href = await resolveLoginDefaultWorkspaceHref();
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
        // EW-074: this value is posted as `username`, but the ONLY place a
        // person ever sees it is the signup field labelled "Full name" — that
        // form has no username field at all. It used to fail with
        // `username.minLength` ("Username must contain at least 3 characters"),
        // naming a field the form does not have, which reads as a bug in the
        // page rather than as something the user can act on. `name.minLength`
        // names what is actually on screen. The rule itself is unchanged, and
        // the form now states it beside the field and checks it before submit.
        //
        // The 3-character floor is the API's (`RegisterDto.username`,
        // `@MinLength(3)` in apps/api/src/auth/dto/auth.dto.ts), and it does
        // exclude ordinary two-character CJK names — 山田 is a real full name —
        // in an app that ships ja/ko/zh. That is a genuine defect, but it
        // cannot be fixed from this file: lowering the web minimum alone would
        // only move the rejection from an instant client-side message to an
        // opaque 400 from the API. It has to change in the DTO first (and in
        // the `dto.spec.ts` cases that pin it), so it is deliberately left at 3
        // here rather than split the client and the server apart.
        //
        // `.trim()` so the client and this schema agree on what "3 characters"
        // means. The form checks the trimmed length — `"  ab  "` is a
        // two-character name however it is padded — and without the same
        // treatment here the client would be the stricter of the two, which is
        // the exact failure mode EW-076 is about, only in the other field.
        username: z
            .string()
            .trim()
            .min(
                VALIDATION_RULES.USERNAME_MIN_LENGTH,
                t('name.minLength', { length: VALIDATION_RULES.USERNAME_MIN_LENGTH }),
            ),
        email: z.string().email(t('email.invalid')),
        password: z
            .string()
            .min(PASSWORD_RULES.MIN_LENGTH, t('password.minLength', { length: 8 }))
            .regex(PASSWORD_RULES.LOWERCASE, t('password.lowercase'))
            .regex(PASSWORD_RULES.NUMBER_OR_SPECIAL, t('password.numberOrSpecial'))
            .regex(PASSWORD_RULES.NOT_STARTING_WITH_DOT_OR_NEWLINE, t('password.cannotStartWith')),
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

    // Honour a stored destination, exactly as `login` does.
    //
    // Registration is the ONLY way an invited outsider gets an account, and
    // without this the organization-invitation flow silently loses them: the
    // landing page stores `/org-invite/<token>` in `redirect_url`, sends them
    // here to sign up, and this returned them to the dashboard instead — with
    // the invitation unaccepted and no longer reachable from anywhere in the
    // UI. `login` has always consulted the cookie; `register` never did, so
    // the "create an account" half of every invite link was a dead end.
    //
    // `getRedirectUrl` validates the stored value (relative or allow-listed
    // host only), so this cannot become an open redirect, and it returns the
    // href above unchanged when nothing is stored.
    href = await getRedirectUrl(authResponse, href);

    // 🛑 The unverified-email notice is applied AFTER the destination is
    // resolved, not before. `getRedirectUrl` REPLACES the href wholesale when a
    // cookie is present, so appending the notice first meant it was silently
    // dropped for exactly the users who followed a stored link — which is every
    // invited newcomer, the group most likely to have an unconfirmed address.
    // Applying it last means the notice survives whichever destination wins.
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

// =====================
// Email verification
// =====================

/**
 * EW-070 — request a fresh verification email while SIGNED OUT.
 *
 * The authenticated sibling lives in `actions/settings.ts` and calls
 * `getAuthFromCookie()` first, so it is useless to the people who need it
 * most: an unverified account cannot log in (the API answers 403), which means
 * it can never obtain the session that action requires. Combined with the two
 * "Resend Verification Email" buttons on /auth/error being `href="/"`, a user
 * whose verification mail was lost had no path back at all.
 *
 * The API answers 200 with one fixed message for every outcome — unknown
 * address, already verified, deactivated, or genuinely mailed — so this action
 * deliberately does NOT inspect the body. There is nothing in it to inspect,
 * and inventing a distinction here would undo the anti-enumeration property
 * the server is careful to hold.
 */
export async function requestVerificationEmail(email: string) {
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
        await authAPI.resendVerification({
            email: validation.data,
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });

        return { success: true };
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        // Security: return a generic translated message; never forward the raw
        // upstream `error.message` to the client (it can leak infra detail).
        return {
            success: false,
            error: errorT('resendVerificationFailed'),
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
        // Same shared rules as `register` above. EW-076's underscore gap was
        // copy-pasted into this schema too, so a password the API accepts was
        // rejected here as well.
        password: z
            .string()
            .min(PASSWORD_RULES.MIN_LENGTH, t('password.minLength', { length: 8 }))
            .regex(PASSWORD_RULES.LOWERCASE, t('password.lowercase'))
            .regex(PASSWORD_RULES.NUMBER_OR_SPECIAL, t('password.numberOrSpecial'))
            .regex(PASSWORD_RULES.NOT_STARTING_WITH_DOT_OR_NEWLINE, t('password.cannotStartWith')),
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
        const tReset = await getTranslations('auth.resetPassword.errors');

        // EW-082: every rejection here used to collapse into one string,
        // "Failed to reset password" — which leaves the user unable to tell
        // "your link is dead, get a new one" apart from "the server hiccuped,
        // press the button again". Those need opposite responses, and guessing
        // wrong costs an already locked-out user another round trip through
        // their inbox.
        //
        // Security: still no raw upstream `error.message` reaches the client —
        // every branch returns a translated constant. The classification reads
        // the upstream error; it never forwards it.
        const reason = classifyResetPasswordError(error);

        return {
            success: false,
            error: tReset(reason),
            // Lets the form offer "Request a new link" for exactly the two
            // reasons where a new link is the fix, and stay quiet otherwise.
            reason,
            linkIsDead: resetLinkIsDead(reason),
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
        href = await resolveLoginDefaultWorkspaceHref();
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

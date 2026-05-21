'use server';

import { z } from 'zod';
import { removeAuthAccessCookies, setOAuthStateCookie, setAuthCookies } from '@/lib/auth';
import { ROUTES, withAppUrl } from '@/lib/constants';
import { VALIDATION_RULES } from './validation';
import { authAPI, AuthResponse } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isValidRedirectUrl } from '@/lib/utils';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { OAuthProvider } from '@/lib/api/enums';

export async function login(identifier: string, password: string, redirectUrl: string | null) {
    const t = await getTranslations('validation.auth');

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

        let message = t('invalidCredentials');
        if (error instanceof Error && error.message.includes('suspended')) {
            message = t('account.suspended');
        }

        return {
            success: false,
            error: message,
        };
    }

    if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
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

export async function register(username: string, email: string, password: string) {
    const t = await getTranslations('validation.auth');

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
    });

    // Validate input
    const validation = registerSchema.safeParse({ username, email, password });
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
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });

        await setAuthCookies(authResponse.access_token);
    } catch (error) {
        console.error(error);

        const errorT = await getTranslations('api.errors');
        let message = errorT('registerFailed');

        if (error instanceof Error) {
            if (error.message.includes('exists')) {
                message = t('email.emailAlreadyRegistered');
            } else if (!error.message.includes('Bad Request')) {
                message = error.message;
            }
        }

        return {
            success: false,
            error: message,
        };
    }

    redirect({
        locale: await getLocale(),
        href: ROUTES.DASHBOARD + '?newUser=true',
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

        return {
            success: false,
            error: error instanceof Error ? error.message : t('providerConnectFailed'),
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

        return {
            success: false,
            error: error instanceof Error ? error.message : errorT('forgotPasswordFailed'),
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

        return {
            success: false,
            error: error instanceof Error ? error.message : errorT('resetPasswordFailed'),
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
            magicLinkCallbackUrl: withAppUrl('/login/magic-link'),
        });

        return { success: true };
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        return {
            success: false,
            error: error instanceof Error ? error.message : errorT('magicLinkFailed'),
        };
    }
}

/**
 * Redeem a magic-link token. On success the session cookie is set and
 * the caller is redirected to the dashboard (or the requested
 * `redirectUrl`, when valid). On failure returns an error string so
 * the UI can render a "Send a new link" recovery path.
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

        return {
            success: false,
            error: error instanceof Error ? error.message : errorT('magicLinkInvalid'),
        };
    }

    if (redirectUrl && isValidRedirectUrl(redirectUrl)) {
        href = redirectUrl;
    } else if (authResponse) {
        href = await getRedirectUrl(authResponse, href);
    }

    redirect({ locale: await getLocale(), href });

    return { success: true };
}

// For oAuth connection check file:
// Check apps/web/src/app/auth/[provider]/callback/route.ts

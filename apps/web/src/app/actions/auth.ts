'use server';

import { z } from 'zod';
import {
    removeAuthAccessCookies,
    removeBetterAuthCookies,
    getBetterAuthCookieHeader,
    getRefreshCookie,
    setOAuthStateCookie,
    setAuthCookies,
} from '@/lib/auth';
import { API_URL, ROUTES, routeWithParams, withAppUrl } from '@/lib/constants';
import { VALIDATION_RULES } from './validation';
import { authAPI, AuthResponse } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isValidRedirectUrl } from '@/lib/utils';
import { getRedirectUrl } from '@/lib/auth/redirect';
import { generateHexToken } from '@/lib/utils/random';
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

        await setAuthCookies(authResponse.access_token, authResponse.refresh_token);
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
            .min(6, t('password.minLength', { length: 6 }))
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

    try {
        const response = await authAPI.register({
            username: validation.data.username,
            email: validation.data.email,
            password: validation.data.password,
            emailVerificationCallbackUrl: withAppUrl(ROUTES.API_AUTH_VERIFY_EMAIL),
        });

        await setAuthCookies(response.access_token, response.refresh_token);
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
        const betterAuthCookies = await getBetterAuthCookieHeader();
        if (betterAuthCookies) {
            await fetch(`${API_URL}/auth/better-auth/sign-out`, {
                method: 'POST',
                headers: {
                    Cookie: betterAuthCookies,
                },
                cache: 'no-store',
            });
        }

        const refresh_token = await getRefreshCookie();
        if (refresh_token) {
            await authAPI.logout({ refreshToken: refresh_token });
        }
    } catch (error) {
        console.error(error);
    }

    await Promise.all([removeAuthAccessCookies(), removeBetterAuthCookies()]);

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
        const state = generateHexToken(16);
        await setOAuthStateCookie(state);

        const callbackUrl = routeWithParams(ROUTES.API_OAUTH_CALLBACK, { providerId });

        switch (providerId) {
            case OAuthProvider.GITHUB: {
                const { url } = await authAPI.getGitHubAuthUrl(withAppUrl(callbackUrl), state);
                return {
                    success: true,
                    url,
                };
            }
            case OAuthProvider.GOOGLE: {
                const { url } = await authAPI.getGoogleAuthUrl(withAppUrl(callbackUrl), state);
                return {
                    success: true,
                    url,
                };
            }
            default: {
                const t = await getTranslations('api.errors');
                return {
                    success: false,
                    error: t('unsupportedProvider'),
                };
            }
        }
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
            .min(6, t('password.minLength', { length: 6 }))
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

// For oAuth connection check file:
// Check apps/web/src/app/auth/[provider]/callback/route.ts

'use server';

import { z } from 'zod';
import {
    removeAuthAccessCookies,
    removeBetterAuthCookies,
    getBetterAuthCookieHeader,
    getRefreshCookie,
    setOAuthStateCookie,
} from '@/lib/auth';
import { API_URL, ROUTES, routeWithParams, withAppUrl } from '@/lib/constants';
import { authAPI } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { generateHexToken } from '@/lib/utils/random';
import { OAuthProvider } from '@/lib/api/enums';

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

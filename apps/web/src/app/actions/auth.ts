'use server';

import { z } from 'zod';
import {
    setAuthCookie,
    setRefreshCookie,
    removeAuthCookies,
    getRefreshCookie,
    setOAuthState,
} from '@/lib/auth/cookies';
import crypto from 'crypto';
import { APP_URL, ROUTES, routeWithParams } from '@/lib/constants';
import { VALIDATION_RULES } from './validation';
import { authAPI } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

export async function login(identifier: string, password: string) {
    const t = await getTranslations('validation.auth');

    // Validation schemas
    const loginSchema = z.object({
        email: z.string().min(1, t('email.required')),
        password: z.string().min(1, t('password.required')),
    });

    // Validate input
    const validation = loginSchema.safeParse({ email: identifier, password });
    if (!validation.success) {
        throw new Error(validation.error.errors[0].message);
    }

    try {
        const response = await authAPI.login({
            email: validation.data.email,
            password: validation.data.password,
        });

        await Promise.all([
            setAuthCookie(response.access_token),
            setRefreshCookie(response.refresh_token),
        ]);

        redirect({
            locale: await getLocale(),
            href: ROUTES.HOME,
        });

        return {
            success: true,
            user: response.user,
        };
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');
        throw new Error(error instanceof Error ? error.message : errorT('loginFailed'));
    }
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
        throw new Error(validation.error.errors[0].message);
    }

    try {
        const response = await authAPI.register({
            username: validation.data.username,
            email: validation.data.email,
            password: validation.data.password,
            email_verification_callback_url: APP_URL + ROUTES.AUTH_LOGIN,
        });

        await Promise.all([
            setAuthCookie(response.access_token),
            setRefreshCookie(response.refresh_token),
        ]);

        redirect({
            locale: await getLocale(),
            href: ROUTES.HOME,
        });

        return {
            success: true,
            user: response.user,
        };
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');
        throw new Error(error instanceof Error ? error.message : errorT('registerFailed'));
    }
}

export async function logout() {
    const refresh_token = await getRefreshCookie();

    const promises: Promise<any>[] = [removeAuthCookies()];

    if (refresh_token) {
        promises.push(authAPI.logout({ refreshToken: refresh_token }));
    }

    // Remove the auth cookie
    await Promise.all(promises);

    // Redirect to home page
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

export async function connectProvider(provider: string) {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        await setOAuthState(state);

        const callbackUrl = routeWithParams(ROUTES.AUTH_CALLBACK, { provider });

        switch (provider) {
            case 'github': {
                const { url } = await authAPI.getGitHubAuthUrl(APP_URL + callbackUrl, state);
                redirect({
                    locale: await getLocale(),
                    href: url,
                });
                break;
            }
            case 'google': {
                const { url } = await authAPI.getGoogleAuthUrl(APP_URL + callbackUrl, state);
                redirect({
                    locale: await getLocale(),
                    href: url,
                });
                break;
            }
            default:
                const t = await getTranslations('api.errors');
                throw new Error(t('unsupportedProvider'));
        }
    } catch (error) {
        console.error(error);
        const t = await getTranslations('api.errors');
        throw new Error(error instanceof Error ? error.message : t('providerConnectFailed'));
    }
}

// For oAuth connection check file:
// Check apps/web/src/app/auth/[provider]/callback/route.ts

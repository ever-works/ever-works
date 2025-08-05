'use server';

import { z } from 'zod';
import {
    setAuthCookie,
    setRefreshCookie,
    removeAuthCookies,
    getRefreshCookie,
    setOAuthState,
    getOAuthState,
} from '@/lib/auth/cookies';
import crypto from 'crypto';
import { APP_URL, ROUTES, routeWithParams } from '@/lib/constants';
import { VALIDATION_RULES } from './validation';
import { authAPI, AuthResponse } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { cookies } from 'next/headers';

export async function login(identifier: string, password: string) {
    // Validation schemas
    const loginSchema = z.object({
        email: z.string().min(1, 'Email  cannot be empty'),
        password: z.string().min(1, 'Password cannot be empty'),
    });

    // Validate input
    const validation = loginSchema.safeParse({ identifier, password });
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
        throw new Error(error instanceof Error ? error.message : 'Login failed');
    }
}

export async function register(username: string, email: string, password: string) {
    const registerSchema = z.object({
        username: z
            .string()
            .min(
                VALIDATION_RULES.USERNAME_MIN_LENGTH,
                `Username must contain at least ${VALIDATION_RULES.USERNAME_MIN_LENGTH} characters`,
            ),
        email: z.string().email('Invalid email'),
        password: z
            .string()
            .min(
                VALIDATION_RULES.PASSWORD_MIN_LENGTH,
                `Password must contain at least ${VALIDATION_RULES.PASSWORD_MIN_LENGTH} characters`,
            )
            .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
            .regex(/[0-9]/, 'Password must contain at least one digit'),
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
        throw new Error(error instanceof Error ? error.message : 'Failed to register');
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
                throw new Error('Unsupported provider');
        }
    } catch (error) {
        console.error(error);
        throw new Error(error instanceof Error ? error.message : 'Failed to connect provider');
    }
}

// For oAuth connection check file:
// Check apps/web/src/app/auth/[provider]/callback/route.ts

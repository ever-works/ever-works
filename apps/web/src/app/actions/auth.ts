'use server';

import { z } from 'zod';
import {
    setAuthCookie,
    removeAuthCookie,
    setRefreshCookie,
    removeAuthCookies,
    getRefreshCookie,
} from '@/lib/auth/cookies';
import { revalidatePath } from 'next/cache';
import { API_URL, ROUTES } from '@/lib/constants';
import { VALIDATION_RULES } from './validation';
import { authAPI } from '@/lib/api';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';

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
        throw new Error(error instanceof Error ? error.message : "Échec de l'inscription");
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
}

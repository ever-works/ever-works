'use server';

import { z } from 'zod';
import { clearAuthSessionCookies, getAuthSessionCookieHeader } from '@/lib/auth';
import { API_URL, ROUTES, withAppUrl } from '@/lib/constants';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

async function parseAuthProviderError(response: Response, fallback: string) {
    try {
        const data = await response.json();
        if (typeof data?.message === 'string' && data.message.trim()) {
            return data.message;
        }
        if (typeof data?.error === 'string' && data.error.trim()) {
            return data.error;
        }
    } catch {}

    const text = await response.text().catch(() => '');
    return text.trim() || fallback;
}

export async function logout() {
    try {
        const authSessionCookies = await getAuthSessionCookieHeader();
        if (authSessionCookies) {
            await fetch(`${API_URL}/auth/provider/sign-out`, {
                method: 'POST',
                headers: {
                    Cookie: authSessionCookies,
                },
                cache: 'no-store',
            });
        }
    } catch (error) {
        console.error(error);
    }

    await clearAuthSessionCookies();

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
// Password Reset
// =================

export async function forgotPassword(email: string) {
    const t = await getTranslations('validation.auth');
    const locale = await getLocale();

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
        const response = await fetch(`${API_URL}/auth/provider/request-password-reset`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email: validation.data,
                redirectTo: withAppUrl(`/${locale}${ROUTES.AUTH_RESET_PASSWORD}`),
            }),
            cache: 'no-store',
        });

        if (!response.ok) {
            throw new Error(
                await parseAuthProviderError(
                    response,
                    'Failed to send password reset instructions',
                ),
            );
        }

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
    const locale = await getLocale();

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
        const response = await fetch(`${API_URL}/auth/provider/reset-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: validation.data.token,
                newPassword: validation.data.password,
            }),
            cache: 'no-store',
        });

        if (!response.ok) {
            throw new Error(await parseAuthProviderError(response, 'Failed to reset password'));
        }
    } catch (error) {
        console.error(error);
        const errorT = await getTranslations('api.errors');

        return {
            success: false,
            error: error instanceof Error ? error.message : errorT('resetPasswordFailed'),
        };
    }

    redirect({
        locale,
        href: ROUTES.AUTH_LOGIN + '?reset=true',
    });

    return {
        success: true,
    };
}

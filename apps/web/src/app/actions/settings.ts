'use server';

import { z } from 'zod';
import { authAPI } from '@/lib/api/auth';
import { settingsAPI } from '@/lib/api/settings';
import { getAuthFromCookie } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';

// Note: Validation schemas are now created inside each function with translations

// Profile Actions
export async function updateProfile(data: { username: string }) {
    const t = await getTranslations('actions.settings.profile');
    
    // Validation schema with translations
    const updateProfileSchema = z.object({
        username: z
            .string()
            .min(1, t('usernameRequired'))
            .max(50, t('usernameMaxLength'))
            .regex(
                /^[a-zA-Z0-9_-]+$/,
                t('usernameFormat'),
            ),
    });
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        // Validate input
        const validation = updateProfileSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const result = await authAPI.updateProfile(validation.data);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS);

        return { success: true, data: result };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('updateFailed'),
        };
    }
}

// Security Actions
export async function updatePassword(data: { currentPassword: string; newPassword: string }) {
    const t = await getTranslations('actions.settings.password');
    
    // Validation schema with translations
    const updatePasswordSchema = z.object({
        currentPassword: z.string().min(1, t('currentRequired')),
        newPassword: z
            .string()
            .min(8, t('newMinLength'))
            .max(100, t('newMaxLength')),
    });
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        // Validate input
        const validation = updatePasswordSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        await authAPI.updatePassword(validation.data);

        return { success: true, message: t('updateSuccess') };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('updateFailed'),
        };
    }
}

// API Token Actions
export async function updateVercelToken(token: string) {
    const t = await getTranslations('actions.settings.vercel');
    
    // Validation schema with translations
    const vercelTokenSchema = z.object({
        token: z
            .string()
            .min(1, t('tokenRequired'))
            .regex(/^vc_[A-Za-z0-9]+$/, t('invalidFormat')),
    });
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        // Validate input
        const validation = vercelTokenSchema.safeParse({ token });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        await settingsAPI.updateVercelToken(validation.data.token);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS);

        return { success: true, message: t('saveSuccess') };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('saveFailed'),
        };
    }
}

export async function removeVercelToken() {
    const t = await getTranslations('actions.settings.vercel');
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        await settingsAPI.removeVercelToken();
        revalidatePath(ROUTES.DASHBOARD_SETTINGS);

        return { success: true, message: t('removeSuccess') };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('removeFailed'),
        };
    }
}

// OAuth Actions
export async function disconnectGitHub() {
    const t = await getTranslations('actions.settings.github');
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        await authAPI.oauth_connections.disconnect('github');
        revalidatePath(ROUTES.DASHBOARD_SETTINGS);

        return { success: true, message: t('disconnectSuccess') };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('disconnectFailed'),
        };
    }
}

// Notification Actions
export async function updateNotificationPreferences(preferences: {
    email: {
        updates: boolean;
        newItems: boolean;
        weeklyDigest: boolean;
        marketing: boolean;
    };
    app: {
        newItems: boolean;
        comments: boolean;
        mentions: boolean;
        systemUpdates: boolean;
    };
}) {
    const t = await getTranslations('actions.settings.notifications');
    
    // Validation schema
    const notificationPreferencesSchema = z.object({
        email: z.object({
            updates: z.boolean(),
            newItems: z.boolean(),
            weeklyDigest: z.boolean(),
            marketing: z.boolean(),
        }),
        app: z.object({
            newItems: z.boolean(),
            comments: z.boolean(),
            mentions: z.boolean(),
            systemUpdates: z.boolean(),
        }),
    });
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        // Validate input
        const validation = notificationPreferencesSchema.safeParse(preferences);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        // This would normally call an API endpoint
        // For now, just simulate success
        await new Promise((resolve) => setTimeout(resolve, 500));

        return { success: true, message: t('updateSuccess') };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('updateFailed'),
        };
    }
}

// Danger Zone Actions
export async function deleteAccount() {
    const t = await getTranslations('actions.settings.danger');
    
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            const errorT = await getTranslations('api.errors');
            return { success: false, error: errorT('notAuthenticated') };
        }

        // This would normally call an API endpoint to delete the account
        // await authAPI.deleteAccount();

        // For safety, not implementing actual deletion in demo
        return { success: false, error: t('deleteDisabled') };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || t('deleteFailed'),
        };
    }
}

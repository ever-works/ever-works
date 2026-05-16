'use server';

import { z } from 'zod';
import { authAPI } from '@/lib/api/auth';
import { getAuthFromCookie } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';
import { VALIDATION_RULES } from './validation';

// Note: Validation schemas are now created inside each function with translations

// Email Verification Actions
export async function resendVerificationEmail() {
    const t = await getTranslations('actions.settings.emailVerification');
    try {
        const user = await getAuthFromCookie();
        if (!user) {
            return { success: false, error: t('notAuthenticated') };
        }
        await authAPI.sendVerification();
        return { success: true, message: t('sent') };
    } catch (error: any) {
        return { success: false, error: error?.message || t('sendFailed') };
    }
}

// Profile Actions
export async function updateProfile(data: {
    username: string;
    committerName?: string | null;
    committerEmail?: string | null;
    /** EW-602: per-user opt-out for budget alert emails. */
    emailBudgetAlerts?: boolean;
}) {
    const t = await getTranslations('actions.settings.profile');
    const tAuth = await getTranslations('validation.auth');

    // Validation schema with translations
    const updateProfileSchema = z.object({
        username: z
            .string()
            .min(
                VALIDATION_RULES.USERNAME_MIN_LENGTH,
                tAuth('username.minLength', { length: VALIDATION_RULES.USERNAME_MIN_LENGTH }),
            ),
        committerName: z.string().nullable().optional(),
        committerEmail: z.string().email().nullable().optional().or(z.literal('')),
        emailBudgetAlerts: z.boolean().optional(),
    });

    try {
        const user = await getAuthFromCookie();
        if (!user) {
            return { success: false, error: t('notAuthenticated') };
        }

        // Validate input
        const validation = updateProfileSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const { committerEmail, ...rest } = validation.data;
        const result = await authAPI.updateProfile({
            ...rest,
            committerEmail: committerEmail === '' ? null : committerEmail,
        });
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
    const tAuth = await getTranslations('validation.auth');

    // Validation schema with translations
    const updatePasswordSchema = z.object({
        currentPassword: z.string().min(1, t('currentRequired')),
        newPassword: z
            .string()
            .min(8, tAuth('password.minLength', { length: 8 }))
            .regex(/[a-z]/, tAuth('password.lowercase'))
            .regex(/(\d|\W)/, tAuth('password.numberOrSpecial'))
            .regex(/^[^.\n]/, tAuth('password.cannotStartWith')),
    });

    try {
        const user = await getAuthFromCookie();
        if (!user) {
            return { success: false, error: t('notAuthenticated') };
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
            return { success: false, error: t('notAuthenticated') };
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
            return { success: false, error: t('notAuthenticated') };
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

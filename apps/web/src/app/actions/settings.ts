'use server';

import { z } from 'zod';
import { authAPI } from '@/lib/api/auth';
import { settingsAPI } from '@/lib/api/settings';
import { getAuthUser } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';

// Validation schemas
const updateProfileSchema = z.object({
    username: z
        .string()
        .min(1, 'Username is required')
        .max(50, 'Username must be less than 50 characters')
        .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, dashes and underscores'),
});

const updatePasswordSchema = z.object({
    currentPassword: z
        .string()
        .min(1, 'Current password is required'),
    newPassword: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .max(100, 'Password must be less than 100 characters'),
});

const vercelTokenSchema = z.object({
    token: z
        .string()
        .min(1, 'Token is required')
        .regex(/^vc_[A-Za-z0-9]+$/, 'Invalid Vercel token format'),
});

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

// Profile Actions
export async function updateProfile(data: { username: string }) {
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
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
            error: error?.message || 'Failed to update profile' 
        };
    }
}

// Security Actions
export async function updatePassword(data: { currentPassword: string; newPassword: string }) {
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
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
        
        return { success: true, message: 'Password updated successfully' };
    } catch (error: any) {
        return { 
            success: false, 
            error: error?.message || 'Failed to update password' 
        };
    }
}

// API Token Actions
export async function updateVercelToken(token: string) {
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
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
        
        return { success: true, message: 'Vercel token saved successfully' };
    } catch (error: any) {
        return { 
            success: false, 
            error: error?.message || 'Failed to save Vercel token' 
        };
    }
}

export async function removeVercelToken() {
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
        }

        await settingsAPI.removeVercelToken();
        revalidatePath(ROUTES.DASHBOARD_SETTINGS);
        
        return { success: true, message: 'Vercel token removed successfully' };
    } catch (error: any) {
        return { 
            success: false, 
            error: error?.message || 'Failed to remove Vercel token' 
        };
    }
}

// OAuth Actions
export async function disconnectGitHub() {
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
        }

        await authAPI.oauth_connections.disconnect('github');
        revalidatePath(ROUTES.DASHBOARD_SETTINGS);
        
        return { success: true, message: 'GitHub account disconnected successfully' };
    } catch (error: any) {
        return { 
            success: false, 
            error: error?.message || 'Failed to disconnect GitHub' 
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
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
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
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return { success: true, message: 'Notification preferences updated successfully' };
    } catch (error: any) {
        return { 
            success: false, 
            error: error?.message || 'Failed to update preferences' 
        };
    }
}

// Danger Zone Actions
export async function deleteAccount() {
    try {
        const user = await getAuthUser();
        if (!user) {
            return { success: false, error: 'Not authenticated' };
        }

        // This would normally call an API endpoint to delete the account
        // await authAPI.deleteAccount();
        
        // For safety, not implementing actual deletion in demo
        return { success: false, error: 'Account deletion is disabled in demo' };
    } catch (error: any) {
        return { 
            success: false, 
            error: error?.message || 'Failed to delete account' 
        };
    }
}
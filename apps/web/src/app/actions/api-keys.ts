'use server';

import { apiKeysAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import type { CreateIntegrationKeyRequest } from '@ever-works/contracts';

export async function createApiKey(data: { name: string; expiresAt?: string }) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await apiKeysAPI.create(data);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_API_KEYS);
        return { success: true, data: result, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to create API key',
        };
    }
}

/** EW-P1-7 — create an integration key (`ew_int_…`): scoped and pinned to organizations. */
export async function createIntegrationKey(data: CreateIntegrationKeyRequest) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await apiKeysAPI.createIntegration(data);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_API_KEYS);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_INTEGRATIONS_EVER_GAUZY);
        return { success: true, data: result, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to create integration key',
        };
    }
}

/** EW-P1-7 — rotate a key in place; the old secret works until the grace period ends. */
export async function rotateApiKey(id: string, graceHours?: number) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await apiKeysAPI.rotate(id, graceHours);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_API_KEYS);
        return { success: true, data: result, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to rotate API key',
        };
    }
}

export async function revokeApiKey(id: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        await apiKeysAPI.revoke(id);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_API_KEYS);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_INTEGRATIONS_EVER_GAUZY);
        return { success: true, error: null };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to revoke API key',
        };
    }
}

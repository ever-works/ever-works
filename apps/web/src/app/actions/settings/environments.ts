'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    environmentsAPI,
    type CreateEnvironmentPayload,
    type Environment,
    type UpdateEnvironmentPayload,
} from '@/lib/api/environments';

/**
 * Environments (Settings → Environments) — Server Actions wrapping the
 * environments API. Discriminated `{ success, data?, error? }` result so
 * the client form surfaces a toast instead of re-throwing across the RSC
 * boundary. Pattern mirrors `app/actions/settings/job-runtime.ts`.
 */

const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/environments';

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError && error.message) return error.message;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

export type EnvironmentActionResult<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

export async function createEnvironmentAction(
    payload: CreateEnvironmentPayload,
): Promise<EnvironmentActionResult<Environment>> {
    await ensureAuth();
    try {
        const data = await environmentsAPI.create(payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to create the environment'),
        };
    }
}

export async function updateEnvironmentAction(
    id: string,
    payload: UpdateEnvironmentPayload,
): Promise<EnvironmentActionResult<Environment>> {
    await ensureAuth();
    try {
        const data = await environmentsAPI.update(id, payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to save the environment'),
        };
    }
}

export async function publishEnvironmentAction(
    id: string,
): Promise<EnvironmentActionResult<Environment>> {
    await ensureAuth();
    try {
        const data = await environmentsAPI.publish(id);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to publish the environment'),
        };
    }
}

export async function deleteEnvironmentAction(
    id: string,
): Promise<EnvironmentActionResult<{ id: string }>> {
    await ensureAuth();
    try {
        await environmentsAPI.remove(id);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data: { id }, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to delete the environment'),
        };
    }
}

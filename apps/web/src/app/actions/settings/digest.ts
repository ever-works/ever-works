'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    digestAPI,
    type DigestSettingsResponse,
    type UpdateDigestSettingsPayload,
} from '@/lib/api/digest';

/**
 * Digest settings — Server Actions over the `/api/digest/settings`
 * surface. Returns the discriminated `{ success, data, error }` shape so
 * the client form can surface a toast or an inline error without
 * re-throwing across the RSC boundary (prod redacts thrown Server Action
 * messages — never branch on them).
 *
 * Pattern mirrors `app/actions/settings/fleet.ts` /
 * `app/actions/settings/job-runtime.ts`.
 */

const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/digest';

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

export type DigestActionResult<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

export async function updateDigestSettingsAction(
    payload: UpdateDigestSettingsPayload,
): Promise<DigestActionResult<DigestSettingsResponse>> {
    await ensureAuth();
    try {
        const data = await digestAPI.updateSettings(payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to save the digest settings'),
        };
    }
}

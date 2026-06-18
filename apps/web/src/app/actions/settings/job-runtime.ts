'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    tenantJobRuntimeAPI,
    type TenantJobRuntimeConfigResponse,
    type TenantJobRuntimeRotateResponse,
    type UpsertTenantJobRuntimeConfigPayload,
} from '@/lib/api/tenant-job-runtime';

/**
 * EW-742 P2.1 — Server Actions wrapping the tenant job-runtime overlay
 * admin API. Returns a discriminated `{ success, data?, error? }` shape
 * so the client form can surface either a toast or an inline error
 * without re-throwing across the RSC boundary.
 *
 * Each action re-verifies the session at the Server Action boundary
 * (defense in depth — the API tier is the final guard, but the API only
 * trusts the JWT, not the action invocation itself). The pattern mirrors
 * `app/actions/settings/work-agent.ts` and `app/actions/api-keys.ts`.
 */

// Settings Layout uses `[locale]/(dashboard)/settings`. revalidatePath
// with a route-group page pattern needs the full segment shape per
// Next.js 15+ docs.
const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/job-runtime';

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

export type JobRuntimeActionResult<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

export async function upsertJobRuntimeConfigAction(
    payload: UpsertTenantJobRuntimeConfigPayload,
): Promise<JobRuntimeActionResult<TenantJobRuntimeConfigResponse>> {
    await ensureAuth();
    try {
        const data = await tenantJobRuntimeAPI.upsertConfig(payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to save job-runtime configuration'),
        };
    }
}

export async function rotateJobRuntimeAction(): Promise<
    JobRuntimeActionResult<TenantJobRuntimeRotateResponse>
> {
    await ensureAuth();
    try {
        const data = await tenantJobRuntimeAPI.rotate();
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to rotate credential'),
        };
    }
}

export async function forceInvalidateJobRuntimeAction(): Promise<
    JobRuntimeActionResult<TenantJobRuntimeRotateResponse>
> {
    await ensureAuth();
    try {
        const data = await tenantJobRuntimeAPI.forceInvalidate();
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to force-invalidate credential'),
        };
    }
}

export async function revertJobRuntimeToInheritAction(): Promise<
    JobRuntimeActionResult<TenantJobRuntimeConfigResponse>
> {
    await ensureAuth();
    try {
        const data = await tenantJobRuntimeAPI.revertToInherit();
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to revert to inherit'),
        };
    }
}

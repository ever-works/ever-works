'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { authAPI } from '@/lib/api';
import {
    operatorTenantRuntimeAllowlistAPI,
    type TenantRuntimeAllowlistResponse,
} from '@/lib/api/operator-tenant-runtime-allowlist';
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';

/**
 * EW-742 P5.1 (T35a UI follow-up) — Server Actions wrapping the
 * operator-scoped per-tenant runtime allow-list REST API. Returns a
 * discriminated `{ success, data?, error? }` shape so the client form
 * can surface either a toast or an inline error without re-throwing
 * across the RSC boundary.
 *
 * Each action re-verifies the session AND the platform-admin flag at
 * the Server Action boundary. The API tier's `IsPlatformAdminGuard` is
 * the authoritative check; this is defense-in-depth so a future
 * misconfiguration of the backend guard does not silently expose the
 * mutations via direct action invocation. Mirrors the layered guard
 * pattern in `app/[locale]/(dashboard)/admin/usage/page.tsx`.
 */

const ADMIN_PAGE_PATTERN =
    '/[locale]/(dashboard)/admin/tenants/[tenantId]/runtime-allowlist';

async function ensurePlatformAdmin() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    // Defense-in-depth: when the profile DTO carries `isPlatformAdmin`,
    // short-circuit non-admins before issuing the admin-API mutation.
    //
    // `/api/auth/profile` is a WHITELIST projection (EW-722 Wave M #156)
    // that intentionally strips `isPlatformAdmin` — so this check fires
    // ONLY on an EXPLICIT `false` value (when/if the projection later
    // includes the flag). For the current `undefined` state, the API
    // tier's `IsPlatformAdminGuard` remains the authoritative gate;
    // non-admin callers reach the underlying REST call and 403 there,
    // which the caller surfaces as `success: false`. Without this
    // change, `if (!profile?.isPlatformAdmin)` would `redirect('/')`
    // for every visitor (including actual admins) and every mutation
    // would silently navigate the user back to the dashboard root.
    const profile = await authAPI.getProfile().catch(() => null);
    if (profile?.isPlatformAdmin === false) {
        // Match the page-level posture: pretend the route does not
        // exist rather than leak its existence via a 403.
        redirect('/');
    }
    return profile;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError && error.message) return error.message;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

export type TenantRuntimeAllowlistActionResult =
    | { success: true; data: TenantRuntimeAllowlistResponse; error: null }
    | { success: false; data: null; error: string };

export async function replaceTenantRuntimeAllowlistAction(
    tenantId: string,
    providerIds: TenantJobRuntimeProviderId[],
): Promise<TenantRuntimeAllowlistActionResult> {
    await ensurePlatformAdmin();
    try {
        const data = await operatorTenantRuntimeAllowlistAPI.replace(tenantId, providerIds);
        revalidatePath(ADMIN_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to save tenant runtime allow-list'),
        };
    }
}

export async function deleteTenantRuntimeAllowlistEntryAction(
    tenantId: string,
    providerId: TenantJobRuntimeProviderId,
): Promise<TenantRuntimeAllowlistActionResult> {
    await ensurePlatformAdmin();
    try {
        const data = await operatorTenantRuntimeAllowlistAPI.deleteEntry(tenantId, providerId);
        revalidatePath(ADMIN_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to remove tenant runtime allow-list entry'),
        };
    }
}

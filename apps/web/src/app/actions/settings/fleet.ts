'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    fleetAPI,
    type CreateFleetEnrollmentTokenPayload,
    type CreateFleetEnrollmentTokenResponse,
    type FleetNodeView,
    type UpdateFleetNodePayload,
} from '@/lib/api/fleet';

/**
 * Fleet (Wave 12, slice 1) — Server Actions wrapping the owner-scoped
 * `/api/fleet` surface. Returns the discriminated `{ success, data,
 * error }` shape so the client form can surface either a toast or an
 * inline error without re-throwing across the RSC boundary (prod
 * redacts thrown Server Action messages — never branch on them).
 *
 * Each action re-verifies the session at the Server Action boundary
 * (defense in depth — the API tier is the final guard). The pattern
 * mirrors `app/actions/settings/job-runtime.ts`.
 */

const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/fleet';

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

export type FleetActionResult<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

export async function createFleetEnrollmentTokenAction(
    payload: CreateFleetEnrollmentTokenPayload,
): Promise<FleetActionResult<CreateFleetEnrollmentTokenResponse>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.createEnrollmentToken(payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to issue an enrollment token'),
        };
    }
}

export async function updateFleetNodeAction(
    nodeId: string,
    payload: UpdateFleetNodePayload,
): Promise<FleetActionResult<FleetNodeView>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.updateNode(nodeId, payload);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to update the node'),
        };
    }
}

export async function deleteFleetNodeAction(
    nodeId: string,
): Promise<FleetActionResult<{ deleted: true }>> {
    await ensureAuth();
    try {
        await fleetAPI.deleteNode(nodeId);
        revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data: { deleted: true }, error: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, 'Failed to remove the node'),
        };
    }
}

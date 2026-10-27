'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
// Security: server actions are reachable as POST endpoints via the `Next-Action`
// header, so every exported action verifies authentication at the Next.js layer
// before proxying — UI gating alone is not a boundary. The API re-checks access.
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    appProvisioningAPI,
    type AppProvisioningCancelAnswer,
    type AppProvisioningStartAnswer,
} from '@/lib/api/app-provisioning';
import type { AppProvisioningState } from '@/lib/works/app-provisioning.shared';

/**
 * APW-04 T25 — the provisioning card's server actions. Every action answers the same
 * projection the Builds actions do: `success`, the payload in `data`, and — on a
 * refusal — the API's own `code` and `statusCode`, so the card maps each code to its
 * copy and no second vocabulary exists here.
 */
export interface AppProvisioningActionResult<T> {
    success: boolean;
    data?: T;
    code?: string;
    statusCode?: number;
    error?: string;
}

const workIdSchema = z.string().min(1).max(64);
const startSchema = z.object({
    restart: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
});

async function requireUser(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function failure<T>(context: string, error: unknown): AppProvisioningActionResult<T> {
    if (error instanceof ApiResponseError) {
        return {
            success: false,
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
        };
    }
    console.error(`Failed to ${context}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
}

function invalid<T>(): AppProvisioningActionResult<T> {
    return { success: false, statusCode: 400, code: 'invalid_request', error: 'Invalid request' };
}

/** The card's read, for the 5-second poll while a provisioning Task is open. */
export async function getAppProvisioningAction(
    workId: string,
): Promise<AppProvisioningActionResult<AppProvisioningState>> {
    await requireUser();
    if (!workIdSchema.safeParse(workId).success) return invalid();
    try {
        return { success: true, data: await appProvisioningAPI.get(workId) };
    } catch (error) {
        return failure('read the App provisioning state', error);
    }
}

/**
 * **Provision** / **Re-provision**. `restart: true` is sent only by the dialog's
 * running-provisioning variant ("start over while one is open").
 */
export async function startAppProvisioningAction(
    workId: string,
    input: { restart?: boolean; note?: string } = {},
): Promise<AppProvisioningActionResult<AppProvisioningStartAnswer>> {
    await requireUser();
    const body = startSchema.safeParse(input);
    if (!workIdSchema.safeParse(workId).success || !body.success) return invalid();
    try {
        const data = await appProvisioningAPI.start(workId, {
            ...(body.data.restart === true ? { restart: true } : {}),
            ...(body.data.note ? { note: body.data.note } : {}),
        });
        revalidatePath(ROUTES.DASHBOARD_WORK(workId));
        return { success: data.started || data.deduplicated, data, code: data.reason ?? undefined };
    } catch (error) {
        return failure('start App provisioning', error);
    }
}

/** **Cancel** — stops the open provisioning Task and its live runs (idempotent). */
export async function cancelAppProvisioningAction(
    workId: string,
): Promise<AppProvisioningActionResult<AppProvisioningCancelAnswer>> {
    await requireUser();
    if (!workIdSchema.safeParse(workId).success) return invalid();
    try {
        const data = await appProvisioningAPI.cancel(workId);
        revalidatePath(ROUTES.DASHBOARD_WORK(workId));
        return { success: data.status === 'cancelled', data, code: data.code };
    } catch (error) {
        return failure('cancel App provisioning', error);
    }
}

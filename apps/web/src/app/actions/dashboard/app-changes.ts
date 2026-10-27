'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { WorkCostRollup } from '@ever-works/contracts';
// Security: server actions are reachable as POST endpoints via the `Next-Action`
// header, so every exported action verifies authentication at the Next.js layer
// before proxying — UI gating alone is not a boundary. The API re-checks access.
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { ApiResponseError } from '@/lib/api/server-api';
import { appChangesAPI, type AppChangeRequestAnswer } from '@/lib/api/app-changes';

/**
 * APW-08 — the App Work overview's **Request a change** dialog and cost summary. Same projection
 * as the provisioning actions: `success`, the payload in `data`, and on a refusal the API's own
 * `code` and `statusCode`, so the component maps each code to its copy (`agentRequired`,
 * `switchOff`, `appSpecMissing`, …) and nothing here branches on a message.
 */
export interface AppChangeActionResult<T> {
    success: boolean;
    data?: T;
    code?: string;
    statusCode?: number;
    error?: string;
}

const workIdSchema = z.string().min(1).max(64);
const requestSchema = z.string().trim().min(1).max(4000);

async function requireUser(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function failure<T>(context: string, error: unknown): AppChangeActionResult<T> {
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

/** **Request a change** — files an App change Task and starts it (or holds it for the owner). */
export async function requestAppChangeAction(
    workId: string,
    request: string,
): Promise<AppChangeActionResult<AppChangeRequestAnswer>> {
    await requireUser();
    const text = requestSchema.safeParse(request);
    if (!workIdSchema.safeParse(workId).success || !text.success) {
        return {
            success: false,
            statusCode: 400,
            code: 'invalid_request',
            error: 'Invalid request',
        };
    }
    try {
        const data = await appChangesAPI.request(workId, { request: text.data });
        revalidatePath(ROUTES.DASHBOARD_WORK(workId));
        return { success: true, data };
    } catch (error) {
        return failure('request an App change', error);
    }
}

/** The month's spend against the Work's budget (`GET /api/works/:id/cost`). */
export async function getWorkCostAction(
    workId: string,
): Promise<AppChangeActionResult<WorkCostRollup>> {
    await requireUser();
    if (!workIdSchema.safeParse(workId).success) {
        return {
            success: false,
            statusCode: 400,
            code: 'invalid_request',
            error: 'Invalid request',
        };
    }
    try {
        return { success: true, data: await appChangesAPI.cost(workId) };
    } catch (error) {
        return failure('read the Work cost', error);
    }
}

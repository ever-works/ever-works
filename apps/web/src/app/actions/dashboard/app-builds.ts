'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AppBuildDetail, AppBuildSummary } from '@ever-works/contracts';
// Security: server actions are reachable as POST endpoints via the
// `Next-Action` header, so every exported action verifies authentication at
// the Next.js layer before proxying — UI gating alone is not a boundary.
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import { ApiResponseError } from '@/lib/api/server-api';
import { appBuildsWebAPI as appBuildsAPI, type AppBuildsListQuery } from '@/lib/api/app-builds';
import type { AppBuildsList, AppBuildsPullAccess } from '@/lib/works/app-builds.shared';

/**
 * APW-05 T25 — the Builds tab's server actions (plan §6.2).
 *
 * Every action answers the same projection: `success`, the payload in `data`,
 * and — on a refusal — the API's own `code`, `statusCode` and `details`,
 * passed through unchanged so the components map each code to the spec's copy
 * (`rebuildRateLimited` + `retryAfterMinutes`, `notCancellable`,
 * `pullTokenTooBroad`, …). A second vocabulary here would be a second answer
 * to the same question.
 */
export interface AppBuildActionResult<T> {
    success: boolean;
    data?: T;
    code?: string;
    statusCode?: number;
    error?: string;
    details?: Record<string, unknown>;
}

const workIdSchema = z.string().min(1).max(64);
const buildIdSchema = z.string().min(1).max(64);
const commitShaSchema = z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional();
// A pasted token is trimmed; GitHub classic tokens are 40 characters, so 1 000
// is a generous ceiling that still refuses an accidental paste of a whole file.
const tokenSchema = z.string().trim().min(1).max(1000);

async function requireUser(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function failure<T>(context: string, error: unknown): AppBuildActionResult<T> {
    if (error instanceof ApiResponseError) {
        return {
            success: false,
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
            details: error.details,
        };
    }
    console.error(`Failed to ${context}:`, error);
    return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
    };
}

function invalid<T>(): AppBuildActionResult<T> {
    return { success: false, statusCode: 400, code: 'invalid_request', error: 'Invalid request' };
}

function revalidateBuilds(workId: string): void {
    revalidatePath(ROUTES.DASHBOARD_WORK(workId));
    revalidatePath(ROUTES.DASHBOARD_WORK_BUILDS(workId));
}

/** The list, for the poll and for **Refresh**. A `404` comes back as `statusCode: 404`. */
export async function listAppBuildsAction(
    workId: string,
    query?: AppBuildsListQuery,
): Promise<AppBuildActionResult<AppBuildsList>> {
    await requireUser();
    if (!workIdSchema.safeParse(workId).success) return invalid();
    try {
        return { success: true, data: await appBuildsAPI.list(workId, query) };
    } catch (error) {
        return failure('list App Work builds', error);
    }
}

/** One Build's detail, for the drawer. */
export async function getAppBuildAction(
    workId: string,
    buildId: string,
): Promise<AppBuildActionResult<AppBuildDetail>> {
    await requireUser();
    if (!workIdSchema.safeParse(workId).success || !buildIdSchema.safeParse(buildId).success) {
        return invalid();
    }
    try {
        return { success: true, data: await appBuildsAPI.get(workId, buildId) };
    } catch (error) {
        return failure('read an App Work build', error);
    }
}

/**
 * **Start build** — a manual Build (plan §5 `POST /api/works/:id/builds`). The API
 * dedupes a second request inside 10 s and answers the same Build with
 * `deduped: true`.
 */
export async function startAppBuildAction(
    workId: string,
    input: { commitSha?: string } = {},
): Promise<
    AppBuildActionResult<{
        build: AppBuildSummary | null;
        buildId: string | null;
        deduped: boolean;
    }>
> {
    await requireUser();
    const sha = commitShaSchema.safeParse(input.commitSha || undefined);
    if (!workIdSchema.safeParse(workId).success || !sha.success) return invalid();
    try {
        const data = await appBuildsAPI.start(workId, sha.data ? { commitSha: sha.data } : {});
        revalidateBuilds(workId);
        return { success: true, data };
    } catch (error) {
        return failure('start an App Work build', error);
    }
}

/** **Cancel** a queued or running Build; `409 notCancellable` once it is terminal. */
export async function cancelAppBuildAction(
    workId: string,
    buildId: string,
): Promise<AppBuildActionResult<{ build: AppBuildSummary | null }>> {
    await requireUser();
    if (!workIdSchema.safeParse(workId).success || !buildIdSchema.safeParse(buildId).success) {
        return invalid();
    }
    try {
        const data = await appBuildsAPI.cancel(workId, buildId);
        revalidateBuilds(workId);
        return { success: true, data };
    } catch (error) {
        return failure('cancel an App Work build', error);
    }
}

/**
 * Save the image pull token (`PUT /api/works/:id/builds/pull-token`). The token
 * travels once, to the API, and is never part of any answer — this action
 * returns the pull-access state only.
 */
export async function setAppBuildPullTokenAction(
    workId: string,
    token: string,
): Promise<AppBuildActionResult<{ pullAccess: AppBuildsPullAccess | null }>> {
    await requireUser();
    const parsed = tokenSchema.safeParse(token);
    if (!workIdSchema.safeParse(workId).success || !parsed.success) return invalid();
    try {
        const data = await appBuildsAPI.savePullToken(workId, parsed.data);
        revalidateBuilds(workId);
        return { success: true, data };
    } catch (error) {
        // Never log the error object here: a provider error message could echo
        // the request body, and that body is the token.
        if (error instanceof ApiResponseError) {
            return {
                success: false,
                code: error.code,
                statusCode: error.statusCode,
                details: error.details,
            };
        }
        return { success: false };
    }
}

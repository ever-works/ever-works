'use server';

import { z } from 'zod';
import { APP_DEPENDENCY_KINDS } from '@ever-works/contracts';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { appDependenciesAPI } from '@/lib/api/app-dependencies';
import {
    APP_DEPENDENCIES_KNOWN_404_CODES,
    APP_DEPENDENCIES_ROUTE_UNAVAILABLE,
    type AppDependenciesListResponse,
    type AppDependencyActionResult,
    type AppDependencyRetryResponse,
    type AppDependencyWriteResponse,
} from '@/lib/api/app-dependencies.types';

/**
 * The Deploy tab's Dependencies card — its three server actions (lane aw-deps-api, APW-07 T25).
 *
 * Security: a server action is a POST endpoint (`Next-Action` header), so each one verifies the
 * session itself; the API repeats the access check (view to read, edit to write) and the typed-slug
 * check of **Delete data**.
 */

const workIdSchema = z.string().uuid();
const kindSchema = z.enum(APP_DEPENDENCY_KINDS);
const slugSchema = z.string().trim().min(1).max(200);

function unauthorized<T>(): AppDependencyActionResult<T> {
    return { success: false, error: 'unauthorized', code: 'unauthorized', httpStatus: 401 };
}

function invalid<T>(code: string): AppDependencyActionResult<T> {
    return { success: false, error: code, code, httpStatus: 400 };
}

function failure<T>(context: string, error: unknown): AppDependencyActionResult<T> {
    if (error instanceof ApiResponseError) {
        // The API's own `404`s carry a code; any other `404` means the route is not deployed yet.
        const code =
            error.statusCode === 404 &&
            !(APP_DEPENDENCIES_KNOWN_404_CODES as readonly string[]).includes(error.code ?? '')
                ? APP_DEPENDENCIES_ROUTE_UNAVAILABLE
                : error.code;
        return { success: false, error: error.message, code, httpStatus: error.statusCode };
    }
    console.error(
        `Failed to ${context}:`,
        error instanceof Error ? error.message : 'unknown error',
    );
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
}

/** Read the App Work's dependency cards. */
export async function getAppDependenciesAction(
    workId: string,
): Promise<AppDependencyActionResult<AppDependenciesListResponse>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) return invalid('invalid_work_id');
    try {
        return { success: true, data: await appDependenciesAPI.list(workId) };
    } catch (error) {
        return failure('read the App dependencies', error);
    }
}

/** **Retry** one dependency — clears its failure and schedules a fresh attempt. */
export async function retryAppDependencyAction(
    workId: string,
    kind: string,
): Promise<AppDependencyActionResult<AppDependencyRetryResponse>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) return invalid('invalid_work_id');
    const parsedKind = kindSchema.safeParse(kind);
    if (!parsedKind.success) return invalid('dependencyNotDeclared');
    try {
        return { success: true, data: await appDependenciesAPI.retry(workId, parsedKind.data) };
    } catch (error) {
        return failure('retry the App dependency', error);
    }
}

/** **Delete data** of one dependency — the typed App Work slug is the confirmation. */
export async function deleteAppDependencyDataAction(
    workId: string,
    kind: string,
    confirmSlug: string,
): Promise<AppDependencyActionResult<AppDependencyWriteResponse>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) return invalid('invalid_work_id');
    const parsedKind = kindSchema.safeParse(kind);
    if (!parsedKind.success) return invalid('dependencyNotDeclared');
    const parsedSlug = slugSchema.safeParse(confirmSlug);
    if (!parsedSlug.success) return invalid('confirmationMismatch');
    try {
        return {
            success: true,
            data: await appDependenciesAPI.deleteData(workId, parsedKind.data, parsedSlug.data),
        };
    } catch (error) {
        return failure('delete the App dependency data', error);
    }
}

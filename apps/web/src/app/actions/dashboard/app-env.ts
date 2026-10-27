'use server';

import { z } from 'zod';
import {
    APP_ENV_NAME_PATTERN,
    APP_ENV_PATCH_MAX_NAMES,
    APP_ENV_VALUE_MAX_BYTES,
} from '@ever-works/contracts';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { appEnvAPI } from '@/lib/api/app-env';
import {
    APP_ENV_IMPORT_MAX_BYTES,
    APP_ENV_ROUTE_UNAVAILABLE,
    type AppEnvActionResult,
    type AppEnvImportPreviewView,
    type AppEnvListResponse,
    type AppEnvPatchResponse,
    type AppEnvRotateView,
} from '@/lib/api/app-env.types';

/**
 * The Deploy tab's Environment card — its two server actions (lane aw-env-smtp, APW-07 T24).
 *
 * Security: a server action is a POST endpoint (`Next-Action` header), so each one verifies the
 * session itself; the API repeats the access check (view to read, edit to write). A value is never
 * logged, never echoed and never returned.
 */

const workIdSchema = z.string().uuid();

const valuesSchema = z
    .record(
        z.string().regex(new RegExp(APP_ENV_NAME_PATTERN)),
        z
            .string()
            .refine((value) => Buffer.byteLength(value, 'utf8') <= APP_ENV_VALUE_MAX_BYTES)
            .nullable(),
    )
    .refine(
        (values) =>
            Object.keys(values).length > 0 && Object.keys(values).length <= APP_ENV_PATCH_MAX_NAMES,
    );

function unauthorized<T>(): AppEnvActionResult<T> {
    return { success: false, error: 'unauthorized', code: 'unauthorized', httpStatus: 401 };
}

function failure<T>(context: string, error: unknown): AppEnvActionResult<T> {
    if (error instanceof ApiResponseError) {
        const details = (error.details ?? {}) as { names?: unknown };
        const names = Array.isArray(details.names)
            ? details.names.map((name) => String(name))
            : undefined;
        // `404 notAppWork` is the API's own answer for an unreachable Work; any other 404 means the
        // route is not deployed on this API yet.
        const code =
            error.statusCode === 404 &&
            error.code !== 'notAppWork' &&
            error.code !== 'appWorksDisabled'
                ? APP_ENV_ROUTE_UNAVAILABLE
                : error.code;
        return {
            success: false,
            error: error.message,
            code,
            httpStatus: error.statusCode,
            ...(names ? { names } : {}),
        };
    }
    // Never the request body: it carries values.
    console.error(
        `Failed to ${context}:`,
        error instanceof Error ? error.message : 'unknown error',
    );
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
}

/** Read the App Work's Environment. */
export async function getAppEnvAction(
    workId: string,
): Promise<AppEnvActionResult<AppEnvListResponse>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    try {
        return { success: true, data: await appEnvAPI.get(workId) };
    } catch (error) {
        return failure('read the App environment', error);
    }
}

/** Set (string) or remove (`null`) declared Environment values. */
export async function updateAppEnvAction(
    workId: string,
    values: Record<string, string | null>,
): Promise<AppEnvActionResult<AppEnvPatchResponse>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    const parsed = valuesSchema.safeParse(values);
    if (!parsed.success) {
        return { success: false, error: 'invalid values', code: 'invalidBody', httpStatus: 400 };
    }
    try {
        return { success: true, data: await appEnvAPI.put(workId, parsed.data) };
    } catch (error) {
        return failure('save the App environment', error);
    }
}

/* -------------------------------------------------------------------------- *
 * Lane aw-ops (APW-07 T24/T28, 2026-10-27) — `.env` import and Rotate
 * -------------------------------------------------------------------------- */

const nameSchema = z.string().regex(new RegExp(APP_ENV_NAME_PATTERN));

/** A paste the API may parse — a string within FR-28's 1 MiB; anything else is `invalidBody`. */
function readPaste(dotenv: unknown): string | null {
    if (typeof dotenv !== 'string') return null;
    if (Buffer.byteLength(dotenv, 'utf8') > APP_ENV_IMPORT_MAX_BYTES) return null;
    return dotenv;
}

/** What a pasted `.env` would change — per line, by name; nothing is stored, no value returns. */
export async function previewAppEnvImportAction(
    workId: string,
    dotenv: string,
): Promise<AppEnvActionResult<AppEnvImportPreviewView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    const paste = readPaste(dotenv);
    if (paste === null) {
        return { success: false, error: 'invalid paste', code: 'valuesTooLarge', httpStatus: 400 };
    }
    try {
        return { success: true, data: await appEnvAPI.previewImport(workId, paste) };
    } catch (error) {
        return failure('preview the .env import', error);
    }
}

/** Import a pasted `.env`: every valid declared line is stored; the answer names, never values. */
export async function importAppEnvAction(
    workId: string,
    dotenv: string,
): Promise<AppEnvActionResult<AppEnvPatchResponse>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    const paste = readPaste(dotenv);
    if (paste === null) {
        return { success: false, error: 'invalid paste', code: 'valuesTooLarge', httpStatus: 400 };
    }
    try {
        return { success: true, data: await appEnvAPI.importDotenv(workId, paste) };
    } catch (error) {
        return failure('import the .env', error);
    }
}

/** **Rotate** one generated value — the typed name is the acknowledgement. */
export async function rotateAppEnvAction(
    workId: string,
    name: string,
    confirmName: string,
): Promise<AppEnvActionResult<AppEnvRotateView>> {
    const user = await getAuthFromCookie();
    if (!user) return unauthorized();
    if (!workIdSchema.safeParse(workId).success) {
        return { success: false, error: 'invalid work id', code: 'invalid_work_id' };
    }
    if (!nameSchema.safeParse(name).success || typeof confirmName !== 'string' || confirmName.length > 256) {
        return { success: false, error: 'invalid name', code: 'invalidBody', httpStatus: 400 };
    }
    try {
        return { success: true, data: await appEnvAPI.rotate(workId, name, confirmName) };
    } catch (error) {
        return failure('rotate the App env value', error);
    }
}

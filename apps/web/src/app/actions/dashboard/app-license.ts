'use server';

import { z } from 'zod';
import type { LicenseAttestation } from '@ever-works/contracts';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { appLicenseAPI } from '@/lib/api/app-license';
import {
    APP_LICENSE_ROUTE_UNAVAILABLE,
    type AppLicenseActionResult,
    type WorkAppLicenseView,
} from '@/lib/api/app-license.types';

/**
 * The licence attestation dialog's two server actions (APW-03 T44 / APW-06 T37).
 * Both check the session first: a server action is a POST endpoint.
 */

const workIdSchema = z.string().uuid();

function failure<T>(context: string, error: unknown): AppLicenseActionResult<T> {
    if (error instanceof ApiResponseError) {
        // A `404` from the attest route or the read route on an API that does not
        // ship it yet; the read route answers `404 not_found` for an unreachable
        // Work too, which the dialog reads the same way: nothing to show.
        const code =
            error.statusCode === 404 && error.code !== 'not_found'
                ? APP_LICENSE_ROUTE_UNAVAILABLE
                : error.code;
        return { success: false, error: error.message, code, httpStatus: error.statusCode };
    }
    console.error(`Failed to ${context}:`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export async function getAppLicenseAction(
    workId: string,
): Promise<AppLicenseActionResult<WorkAppLicenseView>> {
    const user = await getAuthFromCookie();
    if (!user)
        return { success: false, error: 'unauthorized', code: 'unauthorized', httpStatus: 401 };
    if (!workIdSchema.safeParse(workId).success)
        return { success: false, error: 'invalid work id' };
    try {
        return { success: true, data: await appLicenseAPI.get(workId) };
    } catch (error) {
        return failure('read the App licence', error);
    }
}

export async function attestAppLicenseAction(
    workId: string,
    reviewed: { spdx: string | null; class: string | null },
): Promise<AppLicenseActionResult<{ attestation: LicenseAttestation }>> {
    const user = await getAuthFromCookie();
    if (!user)
        return { success: false, error: 'unauthorized', code: 'unauthorized', httpStatus: 401 };
    if (!workIdSchema.safeParse(workId).success)
        return { success: false, error: 'invalid work id' };
    const body = z
        .object({ spdx: z.string().max(1024).nullable(), class: z.string().max(32).nullable() })
        .safeParse(reviewed);
    if (!body.success) return { success: false, error: 'invalid classification' };
    try {
        return { success: true, data: await appLicenseAPI.attest(workId, body.data) };
    } catch (error) {
        return failure('attest the App licence', error);
    }
}

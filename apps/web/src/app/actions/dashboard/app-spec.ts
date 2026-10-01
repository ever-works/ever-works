'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { workAppSpecAPI, type AppSpecValidateResult } from '@/lib/api/work-app-spec';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
// Security: import ApiResponseError so HTTP status codes can be mapped to
// generic client-safe messages instead of forwarding raw backend strings.
import { ApiResponseError } from '@/lib/api/server-api';

/**
 * APW-03 T16 — server actions for the App spec tab (plan §4.4:592-595).
 *
 * T16 owns the **Re-check** action; the Blueprint and License actions of
 * plan §4.4 (`applyBlueprintAction`, `upgradeBlueprintAction`,
 * `dismissBlueprintUpgradeAction`, `attestLicenseAction`) belong to the tasks
 * that build those cards (T31, T45) and are deliberately NOT created here, so
 * two authors do not define the same action twice.
 *
 * `recheckAppSpecAction` is `POST /api/works/:id/app-spec/validate` with
 * `{ source: 'branch' }`: it queues an evaluation of the tracked branch's head
 * and answers `202 { evaluationPending: true }`. The API coalesces presses
 * (three presses inside 5 s are ONE evaluation, FR-22 / ACC-03-13) and refuses
 * the 7th in a minute (FR-77), so the caller shows `Checking…` and lets the
 * page's poll deliver the new state (plan §5.3:633) rather than assuming this
 * call produced a fresh verdict.
 *
 * Mirrors `./budgets.ts` in this folder: cookie auth, `revalidatePath`, and a
 * `{ success, data, error }` result instead of a thrown error — a Server
 * Action's thrown message is REDACTED in production builds, so branching on
 * `error.message` client-side silently breaks on deploy.
 */

async function requireAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function appSpecPath(workId: string): string {
    return ROUTES.DASHBOARD_WORK_SETTINGS_APP_SPEC(workId);
}

/**
 * Security: map `ApiResponseError` HTTP status codes to generic client-safe
 * messages, so internal backend strings are never forwarded to the browser
 * verbatim. `409`/`403`/`422` are the refusals plan §4.2 names.
 */
function toRecheckClientError(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError) {
        if (error.statusCode === 429) {
            return 'Re-check is limited to 6 times a minute per App Work. Please try again shortly.';
        }
        if (error.statusCode === 422) {
            return 'This Work is not an App Work, so it has no App spec.';
        }
        if (error.statusCode === 404) {
            return 'This App Work could not be found.';
        }
        if (error.statusCode === 403) {
            return 'You do not have permission to re-check the App spec of this Work.';
        }
        return fallback;
    }
    return fallback;
}

export type RecheckAppSpecActionResult =
    | { success: true; data: AppSpecValidateResult; error: null }
    | { success: false; data: null; error: string };

/**
 * **Re-check now** — queue an evaluation of the tracked branch's head.
 *
 * Returns the API's own answer: `{ evaluationPending: true }` from the `202`
 * (the ordinary case), or the inline `{ issues, status, truncated }` a `200`
 * carries. Nothing is inferred from a missing field.
 */
export async function recheckAppSpecAction(workId: string): Promise<RecheckAppSpecActionResult> {
    await requireAuth();
    try {
        const data = await workAppSpecAPI.validate(workId, { source: 'branch' });
        revalidatePath(appSpecPath(workId));
        return { success: true as const, data, error: null };
    } catch (error) {
        // Security: log the full error server-side; return only a generic client-safe message.
        console.error('[recheckAppSpecAction]', error);
        return {
            success: false as const,
            data: null,
            error: toRecheckClientError(error, 'Failed to re-check the App spec'),
        };
    }
}

'use server';

import {
    schedulesAPI,
    type GetSchedulePageParams,
    type GetSchedulesParams,
    type ScheduleEntry,
    type ScheduleHealthSummary,
    type SchedulePage,
    type ScheduleRunNowResult,
} from '@/lib/api/schedules';
import { ApiResponseError } from '@/lib/api/server-api';
import { revalidatePath } from 'next/cache';
// Security: defense-in-depth authn guard, mirroring actions/activity-log.ts.
// serverFetch only attaches the bearer token when an auth cookie is present,
// so without this an unauthenticated invocation would reach the API with no
// Authorization header. The API remains the real authz boundary.
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export async function getSchedules(params?: GetSchedulesParams): Promise<{
    success: boolean;
    schedules: ScheduleEntry[];
    error?: string;
}> {
    // Security: require an authenticated session before hitting the API.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const schedules = await schedulesAPI.getAll(params);
        return { success: true, schedules };
    } catch (error) {
        console.error('Failed to get schedules:', error);
        return {
            success: false,
            schedules: [],
            error: error instanceof Error ? error.message : 'Failed to get schedules',
        };
    }
}

// ── Schedules workspace ─────────────────────────────────────────────────

/**
 * A refused control, carried as data so the surface can say WHY in the
 * user's language: `code` is the API's machine code, `reasonKey` the
 * control-reason translation key when the API sent one.
 */
export type ScheduleActionFailure = {
    ok: false;
    code: string;
    reasonKey: string | null;
    status: number | null;
    runId: string | null;
};

function toFailure(error: unknown, fallbackCode: string): ScheduleActionFailure {
    if (error instanceof ApiResponseError) {
        const details = (error.details ?? {}) as Record<string, unknown>;
        const nested = (details.error ?? {}) as Record<string, unknown>;
        const reasonKey = details.reasonKey ?? nested.reasonKey;
        const runId = details.runId ?? nested.runId;
        return {
            ok: false,
            code:
                error.code ??
                (error.statusCode === 429
                    ? 'RATE_LIMITED'
                    : error.statusCode === 404
                      ? 'NOT_FOUND'
                      : fallbackCode),
            reasonKey: typeof reasonKey === 'string' ? reasonKey : null,
            status: error.statusCode,
            runId: typeof runId === 'string' ? runId : null,
        };
    }
    return { ok: false, code: fallbackCode, reasonKey: null, status: null, runId: null };
}

async function requireSession(): Promise<void> {
    // Security: require an authenticated session before hitting the API.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

/** One page of the workspace Schedules list. Read-only; never throws. */
export async function getSchedulePage(
    params: GetSchedulePageParams = {},
): Promise<{ ok: true; page: SchedulePage } | { ok: false }> {
    await requireSession();
    try {
        return { ok: true, page: await schedulesAPI.getPage(params) };
    } catch (error) {
        console.error('Failed to get schedule page:', error);
        return { ok: false };
    }
}

/** The NEVER RUNS summary (a dry run). Read-only; never throws. */
export async function getScheduleHealth(): Promise<
    { ok: true; summary: ScheduleHealthSummary } | { ok: false }
> {
    await requireSession();
    try {
        return { ok: true, summary: await schedulesAPI.getHealth() };
    } catch (error) {
        console.error('Failed to get schedule health:', error);
        return { ok: false };
    }
}

export async function runScheduleNow(
    id: string,
): Promise<{ ok: true; result: ScheduleRunNowResult } | ScheduleActionFailure> {
    await requireSession();
    try {
        const result = await schedulesAPI.runNow(id);
        revalidatePath(ROUTES.DASHBOARD_ACTIVITY);
        revalidatePath(ROUTES.DASHBOARD_SCHEDULES);
        return { ok: true, result };
    } catch (error) {
        return toFailure(error, 'RUN_NOW_FAILED');
    }
}

export async function pauseSchedule(
    id: string,
    options: { acknowledgeMissionPause?: boolean } = {},
): Promise<{ ok: true; schedule: ScheduleEntry } | ScheduleActionFailure> {
    await requireSession();
    try {
        const schedule = await schedulesAPI.pause(id, options.acknowledgeMissionPause === true);
        revalidatePath(ROUTES.DASHBOARD_ACTIVITY);
        revalidatePath(ROUTES.DASHBOARD_SCHEDULES);
        return { ok: true, schedule };
    } catch (error) {
        return toFailure(error, 'PAUSE_FAILED');
    }
}

export async function resumeSchedule(
    id: string,
): Promise<{ ok: true; schedule: ScheduleEntry } | ScheduleActionFailure> {
    await requireSession();
    try {
        const schedule = await schedulesAPI.resume(id);
        revalidatePath(ROUTES.DASHBOARD_ACTIVITY);
        revalidatePath(ROUTES.DASHBOARD_SCHEDULES);
        return { ok: true, schedule };
    } catch (error) {
        return toFailure(error, 'RESUME_FAILED');
    }
}

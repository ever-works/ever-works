'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type {
    InstanceStatsReportView,
    InstanceStatsStatus,
    StatsSendResult,
    WorksStatsV1Report,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { instanceStatsAPI } from '@/lib/api/instance-stats';

/**
 * Anonymous usage statistics — Server Actions behind Settings → Ever Platform.
 *
 * Each re-checks the session (the API's platform-admin guard is the real
 * gate) and answers a discriminated result with a CODE the page translates —
 * never an upstream message.
 */
const SETTINGS_PAGE_PATTERN = '/[locale]/(dashboard)/settings/ever-platform';

export type InstanceStatsActionCode =
    | 'stats_disabled'
    | 'rate_limited'
    | 'send_in_progress'
    | 'forbidden'
    | 'unavailable'
    | 'failed';

export type InstanceStatsActionResult<T> =
    | { success: true; data: T }
    | { success: false; code: InstanceStatsActionCode };

async function ensureAuth(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);
}

function failure(error: unknown): { success: false; code: InstanceStatsActionCode } {
    if (error instanceof ApiResponseError) {
        if (error.statusCode === 403) return { success: false, code: 'forbidden' };
        if (error.statusCode === 404) return { success: false, code: 'unavailable' };
        if (error.statusCode === 429) return { success: false, code: 'rate_limited' };
        if (error.code === 'stats_disabled') return { success: false, code: 'stats_disabled' };
        if (error.code === 'send_in_progress') return { success: false, code: 'send_in_progress' };
    }
    return { success: false, code: 'failed' };
}

async function run<T>(
    fn: () => Promise<T>,
    revalidate = true,
): Promise<InstanceStatsActionResult<T>> {
    await ensureAuth();
    try {
        const data = await fn();
        if (revalidate) revalidatePath(SETTINGS_PAGE_PATTERN, 'page');
        return { success: true, data };
    } catch (error) {
        return failure(error);
    }
}

export async function getInstanceStatsStatusAction(): Promise<
    InstanceStatsActionResult<InstanceStatsStatus>
> {
    return run(() => instanceStatsAPI.status(), false);
}

export async function getInstanceStatsLastAction(): Promise<
    InstanceStatsActionResult<InstanceStatsReportView | null>
> {
    return run(async () => (await instanceStatsAPI.last()).report, false);
}

export async function previewInstanceStatsAction(): Promise<
    InstanceStatsActionResult<WorksStatsV1Report>
> {
    return run(() => instanceStatsAPI.preview(), false);
}

export async function sendInstanceStatsNowAction(): Promise<
    InstanceStatsActionResult<StatsSendResult[]>
> {
    return run(async () => (await instanceStatsAPI.sendNow()).results);
}

export async function setInstanceStatsEnabledAction(
    enabled: boolean,
): Promise<InstanceStatsActionResult<{ enabled: boolean }>> {
    if (typeof enabled !== 'boolean') return { success: false, code: 'failed' };
    return run(() => instanceStatsAPI.setEnabled(enabled));
}

export async function resetInstanceStatsIdentityAction(): Promise<
    InstanceStatsActionResult<{ instanceId: string; resetCount: number }>
> {
    return run(() => instanceStatsAPI.resetIdentity());
}

'use server';

import {
    activityLogAPI,
    type GetActivityLogParams,
    type ActivityLogEntry,
    type ActivitySummaryResponse,
} from '@/lib/api/activity-log';
// Security: defense-in-depth authn guard for these server actions, mirroring the
// pattern in actions/api-keys.ts. serverFetch only attaches the bearer token when
// an auth cookie is present, so without this an unauthenticated invocation would
// reach the API with no Authorization header. The API remains the real authz
// boundary; this closes the web-layer gap and matches house style.
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export async function getActivityLog(params?: GetActivityLogParams): Promise<{
    success: boolean;
    activities: ActivityLogEntry[];
    total: number;
    error?: string;
}> {
    // Security: require an authenticated session before hitting the API.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await activityLogAPI.getAll(params);
        return {
            success: true,
            activities: response.activities,
            total: response.total,
        };
    } catch (error) {
        console.error('Failed to get activity log:', error);
        return {
            success: false,
            activities: [],
            total: 0,
            error: error instanceof Error ? error.message : 'Failed to get activity log',
        };
    }
}

export async function getRunningActivityCount(): Promise<{
    success: boolean;
    count: number;
}> {
    // Security: require an authenticated session before hitting the API.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await activityLogAPI.getRunningCount();
        return { success: true, count: response.count };
    } catch (error) {
        console.error('Failed to get running activity count:', error);
        return { success: false, count: 0 };
    }
}

export async function getActivitySummary(): Promise<{
    success: boolean;
    counts: ActivitySummaryResponse['counts'];
}> {
    // Security: require an authenticated session before hitting the API.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await activityLogAPI.getSummary();
        return { success: true, counts: response.counts };
    } catch (error) {
        console.error('Failed to get activity summary:', error);
        return {
            success: false,
            counts: {
                pending: 0,
                in_progress: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
            },
        };
    }
}

export async function getActivityById(id: string): Promise<{
    success: boolean;
    activity?: ActivityLogEntry;
    error?: string;
}> {
    // Security: require an authenticated session before hitting the API.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await activityLogAPI.getById(id);
        return {
            success: true,
            activity: response.activity,
        };
    } catch (error) {
        console.error('Failed to get activity by id:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get activity',
        };
    }
}

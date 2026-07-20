'use server';

import { schedulesAPI, type GetSchedulesParams, type ScheduleEntry } from '@/lib/api/schedules';
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

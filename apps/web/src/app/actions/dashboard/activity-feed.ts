'use server';

import {
    activityFeedAPI,
    type FeedResponse,
    type GetActivityFeedParams,
} from '@/lib/api/works/activity-feed';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';

export async function getActivityFeed(
    workId: string,
    params?: GetActivityFeedParams,
): Promise<{ success: true; data: FeedResponse } | { success: false; error: string }> {
    // Security: defense-in-depth auth guard at the web tier — server actions are
    // reachable as POST endpoints via the Next-Action header so UI gating is not
    // a security boundary. Matches the pattern in conversations.ts / budgets.ts.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const data = await activityFeedAPI.get(workId, params);
        return { success: true, data };
    } catch (error) {
        console.error(`Failed to get activity feed for work ${workId}:`, error);
        // Security (info-leak): return a static message instead of the raw
        // error.message — backend/network exception text (internal hostnames,
        // stack details) must not cross the server/client boundary. The full
        // error is already logged server-side above.
        return {
            success: false,
            error: 'Failed to get activity feed',
        };
    }
}

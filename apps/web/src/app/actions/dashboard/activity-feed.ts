'use server';

import {
    activityFeedAPI,
    type FeedResponse,
    type GetActivityFeedParams,
} from '@/lib/api/works/activity-feed';

export async function getActivityFeed(
    workId: string,
    params?: GetActivityFeedParams,
): Promise<{ success: true; data: FeedResponse } | { success: false; error: string }> {
    try {
        const data = await activityFeedAPI.get(workId, params);
        return { success: true, data };
    } catch (error) {
        console.error(`Failed to get activity feed for work ${workId}:`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get activity feed',
        };
    }
}

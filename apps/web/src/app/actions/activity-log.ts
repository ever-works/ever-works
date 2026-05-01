'use server';

import {
    activityLogAPI,
    type GetActivityLogParams,
    type ActivityLogEntry,
    type ActivitySummaryResponse,
} from '@/lib/api/activity-log';

export async function getActivityLog(params?: GetActivityLogParams): Promise<{
    success: boolean;
    activities: ActivityLogEntry[];
    total: number;
    error?: string;
}> {
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

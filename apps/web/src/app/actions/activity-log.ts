'use server';

import { activityLogAPI, type GetActivityLogParams, type ActivityLogEntry } from '@/lib/api/activity-log';

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

export async function dismissActivity(id: string): Promise<{
	success: boolean;
	error?: string;
}> {
	try {
		await activityLogAPI.dismiss(id);
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to dismiss activity',
		};
	}
}

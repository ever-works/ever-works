import type { ActivityLog } from '../entities/activity-log.entity';

export const ACTIVITY_LOG_ANALYTICS_DISPATCHER = 'ACTIVITY_LOG_ANALYTICS_DISPATCHER';

export interface ActivityLogAnalyticsDispatcher {
    track(activity: ActivityLog): Promise<void>;
}

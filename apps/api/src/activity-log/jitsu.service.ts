import { Injectable, Logger } from '@nestjs/common';
import { jitsuAnalytics, type AnalyticsInterface } from '@jitsu/js';
import type { ActivityLogAnalyticsDispatcher } from '@ever-works/agent/activity-log';
import type { ActivityLog } from '@ever-works/agent/entities';

@Injectable()
export class JitsuService implements ActivityLogAnalyticsDispatcher {
    private readonly logger = new Logger(JitsuService.name);
    private readonly client: AnalyticsInterface | null;

    constructor() {
        const host = process.env.JITSU_HOST;
        const writeKey = process.env.JITSU_WRITE_KEY;

        if (!host || !writeKey) {
            this.client = null;
            this.logger.log('Jitsu analytics disabled: missing JITSU_HOST or JITSU_WRITE_KEY');
            return;
        }

        this.client = jitsuAnalytics({
            host,
            writeKey,
        });
    }

    async track(activity: ActivityLog): Promise<void> {
        if (!this.client) {
            return;
        }

        const metadata =
            activity.metadata &&
            typeof activity.metadata === 'object' &&
            !Array.isArray(activity.metadata)
                ? activity.metadata
                : {};

        await this.client.track(activity.action, {
            ...metadata,
            activityId: activity.id,
            userId: activity.userId,
            directoryId: activity.directoryId ?? undefined,
            actionType: activity.actionType,
            action: activity.action,
            status: activity.status,
            summary: activity.summary,
            details: activity.details ?? undefined,
            createdAt: activity.createdAt.toISOString(),
        });
    }
}

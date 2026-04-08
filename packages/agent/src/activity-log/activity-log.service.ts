import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ActivityLogRepository } from '@src/database/repositories/activity-log.repository';
import type {
    CreateActivityLogDto,
    ActivityLogQueryOptions,
    ActivityStatus,
} from '../entities/activity-log.types';
import type { ActivityLog } from '../entities/activity-log.entity';
import {
    ACTIVITY_LOG_ANALYTICS_DISPATCHER,
    type ActivityLogAnalyticsDispatcher,
} from './activity-log-analytics-dispatcher';

@Injectable()
export class ActivityLogService {
    private readonly logger = new Logger(ActivityLogService.name);

    constructor(
        private readonly repository: ActivityLogRepository,
        @Optional()
        @Inject(ACTIVITY_LOG_ANALYTICS_DISPATCHER)
        private readonly analyticsDispatcher?: ActivityLogAnalyticsDispatcher,
    ) {}

    private dispatchAnalytics(activity: ActivityLog) {
        if (!this.analyticsDispatcher) {
            return;
        }

        this.analyticsDispatcher.track(activity).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Activity analytics dispatch failed: ${message}`);
        });
    }

    async log(entry: CreateActivityLogDto): Promise<ActivityLog> {
        const activity = await this.repository.create(entry);
        this.dispatchAnalytics(activity);
        this.logger.debug(
            `Activity logged: [${entry.actionType}] ${entry.summary} (user: ${entry.userId})`,
        );
        return activity;
    }

    async updateStatus(
        id: string,
        status: ActivityStatus,
        details?: Record<string, any>,
    ): Promise<ActivityLog | null> {
        const updateData: Partial<ActivityLog> = { status };
        if (details) {
            updateData.details = details;
        }
        const activity = await this.repository.update(id, updateData);
        if (activity) {
            this.dispatchAnalytics(activity);
        }
        return activity;
    }

    async findAll(
        query: ActivityLogQueryOptions,
    ): Promise<{ activities: ActivityLog[]; total: number }> {
        return this.repository.findByUserId(query);
    }

    async countRunning(userId: string): Promise<number> {
        return this.repository.countByStatus(userId, 'in_progress' as ActivityStatus);
    }

    async summarizeStatuses(userId: string): Promise<Record<ActivityStatus, number>> {
        return this.repository.countByStatuses(userId);
    }

    async findById(id: string): Promise<ActivityLog | null> {
        return this.repository.findById(id);
    }

    async findByIdAndUserId(id: string, userId: string): Promise<ActivityLog | null> {
        return this.repository.findByIdAndUserId(id, userId);
    }

    async exportCsv(query: ActivityLogQueryOptions): Promise<string> {
        const activities = await this.repository.findByUserIdForExport({
            ...query,
            limit: 10000,
            offset: 0,
        });

        const headers = ['Date', 'Action Type', 'Action', 'Status', 'Directory', 'Summary'].join(
            ',',
        );

        const rows = activities.map((a) => {
            const directoryName = (a.directory?.name || '').replace(/"/g, '""');
            const summary = a.summary.replace(/"/g, '""');
            return [
                a.createdAt.toISOString(),
                a.actionType,
                a.action,
                a.status,
                `"${directoryName}"`,
                `"${summary}"`,
            ].join(',');
        });

        return [headers, ...rows].join('\n');
    }
}

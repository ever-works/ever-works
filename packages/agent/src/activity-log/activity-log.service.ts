import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DirectoryGenerationHistoryRepository } from '@src/database/repositories/directory-generation-history.repository';
import { ActivityLogRepository } from '@src/database/repositories/activity-log.repository';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { formatGenerationCountsSummary, formatStoredActivitySummary } from './activity-log-summary';
import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
    type ActivityLogQueryOptions,
} from '../entities/activity-log.types';
import type { ActivityLog } from '../entities/activity-log.entity';
import { GenerateStatusType } from '@src/entities/types';
import {
    ACTIVITY_LOG_ANALYTICS_DISPATCHER,
    type ActivityLogAnalyticsDispatcher,
} from './activity-log-analytics-dispatcher';

@Injectable()
export class ActivityLogService {
    private readonly logger = new Logger(ActivityLogService.name);

    constructor(
        private readonly repository: ActivityLogRepository,
        private readonly directoryRepository: DirectoryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        @Optional()
        @Inject(ACTIVITY_LOG_ANALYTICS_DISPATCHER)
        private readonly analyticsDispatcher?: ActivityLogAnalyticsDispatcher,
    ) {}

    formatGenerationSummary(counts?: {
        newItemsCount?: number | null;
        updatedItemsCount?: number | null;
        totalItemsCount?: number | null;
    }): string {
        return formatGenerationCountsSummary(counts);
    }

    formatSummary(
        activity: Pick<ActivityLog, 'actionType' | 'status' | 'summary' | 'details'>,
    ): string {
        return formatStoredActivitySummary(activity);
    }

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
        updates?: Partial<Pick<ActivityLog, 'action' | 'summary' | 'metadata'>>,
    ): Promise<ActivityLog | null> {
        const updateData: Partial<ActivityLog> = { status };
        if (details) {
            updateData.details = details;
        }
        if (updates) {
            Object.assign(updateData, updates);
        }
        const activity = await this.repository.update(id, updateData);
        if (activity) {
            this.dispatchAnalytics(activity);
        }
        return activity;
    }

    async reconcileStaleGenerationActivities(userId: string): Promise<number> {
        try {
            const activities = await this.repository.findInProgressGenerationsByUserId(userId);

            if (activities.length === 0) {
                return 0;
            }

            const directories = await this.directoryRepository.findByIds(
                activities
                    .map((activity) => activity.directoryId)
                    .filter((directoryId): directoryId is string => !!directoryId),
            );
            const directoriesById = new Map(
                directories.map((directory) => [directory.id, directory]),
            );

            let reconciledCount = 0;

            for (const activity of activities) {
                try {
                    if (
                        !activity.directoryId ||
                        activity.actionType !== ActivityActionType.GENERATION
                    ) {
                        continue;
                    }

                    const directory = directoriesById.get(activity.directoryId);

                    if (directory?.generateStatus?.status === GenerateStatusType.GENERATING) {
                        continue;
                    }

                    const latestHistory = activity.directoryId
                        ? await this.generationHistoryRepository.findLatestCompletedByDirectory(
                              activity.directoryId,
                          )
                        : null;
                    const resolvedStatus =
                        !directory ||
                        directory.generateStatus?.status === GenerateStatusType.ERROR ||
                        directory.generateStatus?.status === GenerateStatusType.CANCELLED
                            ? ActivityStatus.FAILED
                            : ActivityStatus.COMPLETED;
                    const summary = !directory
                        ? 'Generation state is no longer available for this directory'
                        : directory.generateStatus?.status === GenerateStatusType.CANCELLED
                          ? `Generation cancelled for ${directory.name}`
                          : directory.generateStatus?.status === GenerateStatusType.ERROR
                            ? `Generation failed for ${directory.name}`
                            : this.formatGenerationSummary(latestHistory);
                    const existingDetails =
                        activity.details &&
                        typeof activity.details === 'object' &&
                        !Array.isArray(activity.details)
                            ? activity.details
                            : {};

                    const updated = await this.updateStatus(
                        activity.id,
                        resolvedStatus,
                        {
                            ...existingDetails,
                            itemsCount:
                                latestHistory?.totalItemsCount ?? directory?.itemsCount ?? 0,
                            newItemsCount: latestHistory?.newItemsCount ?? 0,
                            updatedItemsCount: latestHistory?.updatedItemsCount ?? 0,
                            generateStatus: directory?.generateStatus ?? null,
                        },
                        {
                            action: 'generation.completed',
                            summary,
                        },
                    );

                    if (updated) {
                        reconciledCount += 1;
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.warn(
                        `Failed to reconcile stale generation activity ${activity.id}: ${message}`,
                    );
                }
            }

            if (reconciledCount > 0) {
                this.logger.debug(
                    `Reconciled ${reconciledCount} stale in-progress generation activit${
                        reconciledCount === 1 ? 'y' : 'ies'
                    } for user ${userId}`,
                );
            }

            return reconciledCount;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Failed to reconcile stale generation activities for user ${userId}: ${message}`,
            );
            return 0;
        }
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

    async findLatestByUserDirectoryActionStatus(params: {
        userId: string;
        directoryId: string;
        actionType: ActivityActionType;
        status: ActivityStatus;
    }): Promise<ActivityLog | null> {
        return this.repository.findLatestByUserDirectoryActionStatus(params);
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
            const summary = this.formatSummary(a).replace(/"/g, '""');
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

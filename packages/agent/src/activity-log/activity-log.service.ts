import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WorkGenerationHistoryRepository } from '@src/database/repositories/work-generation-history.repository';
import { ActivityLogRepository } from '@src/database/repositories/activity-log.repository';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { formatGenerationCountsSummary, formatStoredActivitySummary } from './activity-log-summary';
import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
    type ActivityLogQueryOptions,
} from '../entities/activity-log.types';
import type { ActivityLog } from '../entities/activity-log.entity';
import type { Work } from '../entities/work.entity';
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
        private readonly workRepository: WorkRepository,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
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

    resolveGenerationActivityStatus(work?: Pick<Work, 'generateStatus'> | null): ActivityStatus {
        if (!work) {
            return ActivityStatus.FAILED;
        }

        switch (work.generateStatus?.status) {
            case GenerateStatusType.CANCELLED:
                return ActivityStatus.CANCELLED;
            case GenerateStatusType.ERROR:
                return ActivityStatus.FAILED;
            default:
                return ActivityStatus.COMPLETED;
        }
    }

    formatGenerationCompletionSummary(
        work: Pick<Work, 'name' | 'generateStatus'> | null | undefined,
        counts?: {
            newItemsCount?: number | null;
            updatedItemsCount?: number | null;
            totalItemsCount?: number | null;
        },
    ): string {
        if (!work) {
            return 'Generation state is no longer available for this work';
        }

        switch (work.generateStatus?.status) {
            case GenerateStatusType.CANCELLED:
                return `Generation cancelled for ${work.name}`;
            case GenerateStatusType.ERROR:
                return `Generation failed for ${work.name}`;
            default:
                return this.formatGenerationSummary(counts);
        }
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

    async log(
        entry: CreateActivityLogDto,
        overrides?: { createdAt?: Date },
    ): Promise<ActivityLog> {
        const activity = await this.repository.create(entry, overrides);
        this.dispatchAnalytics(activity);
        this.logger.debug(
            `Activity logged: [${entry.actionType}] ${entry.summary} (user: ${entry.userId})`,
        );
        return activity;
    }

    /**
     * Persist an event POSTed by a deployed directory site (EW-120).
     *
     * Idempotent by `(workId, eventId)` — a retry from the website lands on
     * the same row instead of creating duplicates. The attribution `userId`
     * is the Work owner so the event surfaces in their per-Work Activity
     * Feed without authenticating the end-user that triggered it.
     */
    async ingestFromWebsite(payload: {
        workId: string;
        eventId: string;
        actionType: ActivityActionType;
        occurredAt: Date;
        summary: string;
        metadata?: Record<string, unknown>;
    }): Promise<ActivityLog> {
        const existing = await this.repository.findByWorkAndIngestEventId(
            payload.workId,
            payload.eventId,
        );
        if (existing) {
            return existing;
        }

        const work = await this.workRepository.findById(payload.workId);
        if (!work) {
            throw new Error(`Work ${payload.workId} not found`);
        }

        // Pin `createdAt` to the website's `occurredAt` so the feed
        // orders by "when it happened" rather than "when the platform
        // got around to recording it". TypeORM's @CreateDateColumn only
        // auto-populates when the value is left undefined.
        return this.log(
            {
                userId: work.userId,
                workId: payload.workId,
                actionType: payload.actionType,
                action: `website.${payload.actionType}`,
                status: ActivityStatus.COMPLETED,
                summary: payload.summary,
                metadata: {
                    ...(payload.metadata ?? {}),
                    occurredAt: payload.occurredAt.toISOString(),
                },
                ingestEventId: payload.eventId,
            },
            { createdAt: payload.occurredAt },
        );
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

            const works = await this.workRepository.findByIds(
                activities
                    .map((activity) => activity.workId)
                    .filter((workId): workId is string => !!workId),
            );
            const worksById = new Map(works.map((work) => [work.id, work]));

            let reconciledCount = 0;

            for (const activity of activities) {
                try {
                    if (!activity.workId || activity.actionType !== ActivityActionType.GENERATION) {
                        continue;
                    }

                    const work = worksById.get(activity.workId);

                    if (work?.generateStatus?.status === GenerateStatusType.GENERATING) {
                        continue;
                    }

                    const latestHistory = activity.workId
                        ? await this.generationHistoryRepository.findLatestCompletedByWork(
                              activity.workId,
                          )
                        : null;
                    const resolvedStatus = this.resolveGenerationActivityStatus(work);
                    const summary = this.formatGenerationCompletionSummary(work, latestHistory);
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
                            itemsCount: latestHistory?.totalItemsCount ?? work?.itemsCount ?? 0,
                            newItemsCount: latestHistory?.newItemsCount ?? 0,
                            updatedItemsCount: latestHistory?.updatedItemsCount ?? 0,
                            generateStatus: work?.generateStatus ?? null,
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

    /**
     * Per-Work activity lookup that bypasses the `userId` filter. Use for
     * the work-scoped Activity Feed; access must have been verified
     * upstream (controller layer). See repository docstring for context.
     */
    async findByWork(options: {
        workId: string;
        actionType?: ActivityActionType;
        dateTo?: Date;
        limit?: number;
        offset?: number;
    }): Promise<{ activities: ActivityLog[]; total: number }> {
        return this.repository.findByWork(options);
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

    async findLatestByUserWorkActionStatus(params: {
        userId: string;
        workId: string;
        actionType: ActivityActionType;
        status: ActivityStatus;
    }): Promise<ActivityLog | null> {
        return this.repository.findLatestByUserWorkActionStatus(params);
    }

    async exportCsv(query: ActivityLogQueryOptions): Promise<string> {
        const activities = await this.repository.findByUserIdForExport({
            ...query,
            limit: 10000,
            offset: 0,
        });

        const headers = ['Date', 'Action Type', 'Action', 'Status', 'Work', 'Summary'].join(',');

        const rows = activities.map((a) => {
            const workName = (a.work?.name || '').replace(/"/g, '""');
            const summary = this.formatSummary(a).replace(/"/g, '""');
            return [
                a.createdAt.toISOString(),
                a.actionType,
                a.action,
                a.status,
                `"${workName}"`,
                `"${summary}"`,
            ].join(',');
        });

        return [headers, ...rows].join('\n');
    }
}

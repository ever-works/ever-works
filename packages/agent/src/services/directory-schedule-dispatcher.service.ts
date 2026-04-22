import { Injectable, Logger } from '@nestjs/common';
import { config } from '@src/config';
import { DirectoryScheduleRepository } from '@src/database/repositories/directory-schedule.repository';
import { DirectoryGenerationService } from './directory-generation.service';
import { DirectoryScheduleService } from './directory-schedule.service';
import type { DirectorySchedule } from '@src/entities/directory-schedule.entity';

export interface DirectoryScheduleDispatchEntry {
    scheduleId: string;
    directoryId: string;
    directoryName: string;
    directorySlug: string;
    directoryOwner: string;
    scheduledFor: string | null;
    outcome: 'dispatched' | 'skipped' | 'failed';
    message?: string;
    historyId?: string;
}

export interface DirectoryScheduleDispatchSummary {
    limit: number;
    dueCount: number;
    dispatched: number;
    skipped: number;
    failed: number;
    entries: DirectoryScheduleDispatchEntry[];
}

@Injectable()
export class DirectoryScheduleDispatcherService {
    private readonly logger = new Logger(DirectoryScheduleDispatcherService.name);

    constructor(
        private readonly scheduleRepository: DirectoryScheduleRepository,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly directoryScheduleService: DirectoryScheduleService,
    ) {}

    async dispatchDue(
        limit = config.subscriptions.getMaxBatch(),
    ): Promise<DirectoryScheduleDispatchSummary> {
        if (!config.subscriptions.scheduledUpdatesEnabled()) {
            this.logger.warn('Scheduled updates disabled, skipping dispatch');
            return {
                limit,
                dueCount: 0,
                dispatched: 0,
                skipped: 0,
                failed: 0,
                entries: [],
            };
        }

        // Step 0: Cleanup zombies
        await this.directoryScheduleService.recoverStuckSchedules();

        const schedules = await this.scheduleRepository.findDue(limit);
        const summary: DirectoryScheduleDispatchSummary = {
            limit,
            dueCount: schedules.length,
            dispatched: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const schedule of schedules) {
            try {
                const reservedSchedule =
                    (await this.directoryScheduleService.markRunDispatched(schedule.id)) || null;

                if (!reservedSchedule) {
                    this.logger.warn(`Schedule ${schedule.id} was already dispatched, skipping`);
                    summary.skipped += 1;
                    summary.entries.push(
                        this.buildEntry(schedule, {
                            outcome: 'skipped',
                            message: 'Schedule was already dispatched by another worker',
                        }),
                    );
                    continue;
                }

                const result =
                    await this.directoryGenerationService.runScheduledUpdate(reservedSchedule);
                const resultData = result && typeof result === 'object' ? result : null;

                if (resultData?.status === 'skipped') {
                    summary.skipped += 1;
                    summary.entries.push(
                        this.buildEntry(reservedSchedule, {
                            outcome: 'skipped',
                            message: resultData.message,
                            historyId: resultData.historyId,
                        }),
                    );
                    continue;
                }

                summary.dispatched += 1;
                summary.entries.push(
                    this.buildEntry(reservedSchedule, {
                        outcome: 'dispatched',
                        message: resultData?.message,
                        historyId: resultData?.historyId,
                    }),
                );
            } catch (error) {
                // Schedule finalization (markRunFailed) is handled by the inner methods:
                // - finalizeGeneration (for generation errors)
                // - handleSyncFailure (for sync errors)
                // - updateItemsGenerator early-exit (for config errors)
                // We only log here to avoid double-counting failures.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(
                    `Failed to dispatch scheduled update for directory ${schedule.directoryId}`,
                    error as Error,
                );
                summary.failed += 1;
                summary.entries.push(
                    this.buildEntry(schedule, {
                        outcome: 'failed',
                        message,
                    }),
                );
            }
        }

        return summary;
    }

    private buildEntry(
        schedule: DirectorySchedule,
        details: Pick<DirectoryScheduleDispatchEntry, 'outcome' | 'message' | 'historyId'>,
    ): DirectoryScheduleDispatchEntry {
        const directory = schedule.directory;

        return {
            scheduleId: schedule.id,
            directoryId: schedule.directoryId,
            directoryName: directory?.name ?? schedule.directoryId,
            directorySlug: directory?.slug ?? '',
            directoryOwner: directory?.getRepoOwner?.() ?? directory?.owner ?? '',
            scheduledFor:
                schedule.scheduledFor?.toISOString() ?? schedule.nextRunAt?.toISOString() ?? null,
            outcome: details.outcome,
            message: details.message,
            historyId: details.historyId,
        };
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { DirectoryScheduleDispatcherService } from '@ever-works/agent/services';

const SCHEDULE_DISPATCH_LOCK_KEY = 'directories:schedule-dispatcher';

@Injectable()
export class DirectoryScheduleDispatcherCronService {
    private readonly logger = new Logger(DirectoryScheduleDispatcherCronService.name);

    constructor(
        private readonly dispatcher: DirectoryScheduleDispatcherService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_MINUTE)
    async dispatchDueSchedules() {
        if (!this.shouldUseNestScheduler()) {
            return;
        }

        if (!this.isDispatchMinute(new Date())) {
            return;
        }

        const intervalMinutes = this.getDispatchIntervalMinutes();
        const ttlMs = Math.max(intervalMinutes * 60 * 1000, 60_000);

        await this.taskLockService.runExclusive(
            SCHEDULE_DISPATCH_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.dispatcher.dispatchDue();

                    if (summary.dueCount > 0 || summary.failed > 0) {
                        this.logger.log(
                            `Directory schedule dispatch completed: ${summary.dispatched} dispatched, ${summary.skipped} skipped, ${summary.failed} failed (${summary.dueCount} due)`,
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('Directory schedule dispatch failed', stack);
                }
            },
            {
                ttlMs,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping directory schedule dispatch because another instance holds the task lock',
                    ),
            },
        );
    }

    private shouldUseNestScheduler(): boolean {
        if (!config.subscriptions.scheduledUpdatesEnabled()) {
            return false;
        }

        return !config.trigger.shouldUseTrigger();
    }

    private isDispatchMinute(date: Date): boolean {
        const epochMinute = Math.floor(date.getTime() / 60_000);
        return epochMinute % this.getDispatchIntervalMinutes() === 0;
    }

    private getDispatchIntervalMinutes(): number {
        return Math.max(1, config.subscriptions.getDispatchIntervalMinutes());
    }
}

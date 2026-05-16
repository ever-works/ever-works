import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { PluginUsageRepository } from '@ever-works/agent/database';

/**
 * EW-602 — Per-call usage events drive dashboards, budget alerts, and
 * the admin spend view; once an event is older than 12 months it has
 * served all those purposes and only adds table bulk. This service
 * prunes events older than the retention window once a day.
 *
 * The pre-aggregated WorkBudgetAlertState rows are scoped to the
 * current period and don't accumulate, so they aren't pruned here.
 */
const RETENTION_MONTHS = 12;

@Injectable()
export class PluginUsageCleanupService {
    private readonly logger = new Logger(PluginUsageCleanupService.name);

    constructor(
        private readonly usageRepository: PluginUsageRepository,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_DAY_AT_4AM)
    async pruneOldEvents(): Promise<void> {
        await this.taskLockService.runExclusive(
            'plugin-usage:cleanup',
            async () => {
                const cutoff = this.computeCutoff();
                this.logger.log(
                    `Pruning plugin_usage_events older than ${cutoff.toISOString()} (${RETENTION_MONTHS}-month retention)...`,
                );

                try {
                    const deleted = await this.usageRepository.pruneOlderThan(cutoff);
                    this.logger.log(`Plugin usage cleanup completed: ${deleted} rows pruned`);
                } catch (error) {
                    this.logger.error('Plugin usage cleanup failed:', error);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping plugin usage cleanup because another instance holds the task lock',
                    ),
            },
        );
    }

    private computeCutoff(now: Date = new Date()): Date {
        const cutoff = new Date(now);
        cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
        return cutoff;
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { WorkProposalsApiService } from './work-proposals.service';

const SCHEDULE_LOCK_KEY = 'user-research:scheduled-rerun';

@Injectable()
export class ScheduledReRunService {
    private readonly logger = new Logger(ScheduledReRunService.name);

    constructor(
        private readonly proposals: WorkProposalsApiService,
        private readonly config: ConfigService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async runDaily(): Promise<void> {
        if (!this.shouldUseNestScheduler()) {
            return;
        }

        await this.taskLockService.runExclusive(
            SCHEDULE_LOCK_KEY,
            async () => this.proposals.runScheduledBatch(),
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping scheduled rerun because another instance holds the task lock',
                    ),
            },
        );
    }

    private shouldUseNestScheduler(): boolean {
        const enabled = this.config.get<string | boolean>(
            'USER_RESEARCH_SCHEDULED_RERUN_ENABLED',
            false,
        );
        const isEnabled = typeof enabled === 'string' ? enabled === 'true' : !!enabled;
        if (!isEnabled) return false;

        return !config.trigger.shouldUseTrigger();
    }
}

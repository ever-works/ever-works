import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { CommunityPrProcessorService } from '@ever-works/agent/community-pr';

@Injectable()
export class CommunityPrSchedulerService {
    private readonly logger = new Logger(CommunityPrSchedulerService.name);

    constructor(
        private readonly communityPrProcessor: CommunityPrProcessorService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_HOUR)
    async handleCommunityPrProcessing() {
        await this.taskLockService.runExclusive(
            'works:community-pr-scheduler',
            async () => {
                try {
                    this.logger.log('Starting community PR processing');
                    const result = await this.communityPrProcessor.processAllWorks();
                    this.logger.log(
                        `Community PR processing completed: ${result.processed} processed, ${result.errors.length} errors`,
                    );
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('Error during community PR processing', stack);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping community PR processing because another instance holds the task lock',
                    ),
            },
        );
    }
}

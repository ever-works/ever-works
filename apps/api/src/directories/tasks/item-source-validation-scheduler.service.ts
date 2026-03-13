import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ItemSourceValidationSchedulerService } from '@ever-works/agent/services';

@Injectable()
export class ItemSourceValidationCronService {
    private readonly logger = new Logger(ItemSourceValidationCronService.name);

    constructor(
        private readonly sourceValidationScheduler: ItemSourceValidationSchedulerService,
    ) {}

    @Cron(CronExpression.EVERY_6_HOURS)
    async handleScheduledSourceValidation() {
        try {
            this.logger.log('Starting scheduled item source validation');
            const result = await this.sourceValidationScheduler.processAllDirectories();
            this.logger.log(
                `Scheduled item source validation completed: ${result.processed} processed, ${result.skipped} skipped, ${result.errors.length} errors`,
            );
        } catch (error) {
            const stack = error instanceof Error ? error.stack : String(error);
            this.logger.error('Error during scheduled item source validation', stack);
        }
    }
}

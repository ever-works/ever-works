import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheEntryRepository, DistributedTaskLockService } from '@ever-works/agent/cache';
import { ItemSourceValidationSchedulerService } from '@ever-works/agent/services';
import {
    WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
    WORK_CONFIG_CACHE_KEY_PREFIX,
    WORK_COUNT_CACHE_KEY_PREFIX,
    WORK_ITEMS_CACHE_KEY_PREFIX,
} from '../work-cache.constants';
@Injectable()
export class ItemSourceValidationCronService {
    private readonly logger = new Logger(ItemSourceValidationCronService.name);

    constructor(
        private readonly sourceValidationScheduler: ItemSourceValidationSchedulerService,
        private readonly cacheEntryRepository: CacheEntryRepository,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_HOUR)
    async handleScheduledSourceValidation() {
        await this.taskLockService.runExclusive(
            'works:item-source-validation-scheduler',
            async () => {
                try {
                    this.logger.log('Starting scheduled item source validation');
                    const result = await this.sourceValidationScheduler.processDueSchedules();
                    await Promise.all([
                        this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                            WORK_ITEMS_CACHE_KEY_PREFIX,
                        ),
                        this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                            WORK_CONFIG_CACHE_KEY_PREFIX,
                        ),
                        this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                            WORK_COUNT_CACHE_KEY_PREFIX,
                        ),
                        this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                            WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
                        ),
                    ]);
                    this.logger.log(
                        `Scheduled item source validation completed: ${result.processed} processed, ${result.skipped} skipped, ${result.itemsChecked} items checked, ${result.itemsChanged} items changed, ${result.errors.length} errors`,
                    );
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('Error during scheduled item source validation', stack);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping scheduled item source validation because another instance holds the task lock',
                    ),
            },
        );
    }
}

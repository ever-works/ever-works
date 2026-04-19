import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheEntryRepository } from '@ever-works/agent/cache';
import { ItemSourceValidationSchedulerService } from '@ever-works/agent/services';
import {
    DIRECTORY_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
    DIRECTORY_CONFIG_CACHE_KEY_PREFIX,
    DIRECTORY_COUNT_CACHE_KEY_PREFIX,
    DIRECTORY_ITEMS_CACHE_KEY_PREFIX,
} from '../directory-cache.constants';

@Injectable()
export class ItemSourceValidationCronService {
    private readonly logger = new Logger(ItemSourceValidationCronService.name);

    constructor(
        private readonly sourceValidationScheduler: ItemSourceValidationSchedulerService,
        private readonly cacheEntryRepository: CacheEntryRepository,
    ) {}

    @Cron(CronExpression.EVERY_HOUR)
    async handleScheduledSourceValidation() {
        try {
            this.logger.log('Starting scheduled item source validation');
            const result = await this.sourceValidationScheduler.processDueSchedules();
            await Promise.all([
                this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                    DIRECTORY_ITEMS_CACHE_KEY_PREFIX,
                ),
                this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                    DIRECTORY_CONFIG_CACHE_KEY_PREFIX,
                ),
                this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                    DIRECTORY_COUNT_CACHE_KEY_PREFIX,
                ),
                this.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike(
                    DIRECTORY_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
                ),
            ]);
            this.logger.log(
                `Scheduled item source validation completed: ${result.processed} processed, ${result.skipped} skipped, ${result.itemsChecked} items checked, ${result.itemsChanged} items changed, ${result.errors.length} errors`,
            );
        } catch (error) {
            const stack = error instanceof Error ? error.stack : String(error);
            this.logger.error('Error during scheduled item source validation', stack);
        }
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { ItemsGeneratorMetrics } from '../dto/items-generator-response.dto';
import { ItemData } from '../dto';
import {
    SharedUtilsService,
    NewItemsExtractorService,
    AiDeduplicatorService,
} from './data-aggregation';

@Injectable()
export class DataAggregationService {
    private readonly logger = new Logger(DataAggregationService.name);

    constructor(
        private readonly sharedUtils: SharedUtilsService,
        private readonly newItemsExtractor: NewItemsExtractorService,
        private readonly aiDeduplicator: AiDeduplicatorService,
    ) {}

    /**
     * Aggregates and deduplicates data from multiple sources
     */
    async aggregateAndDeduplicateData(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        existingItems: ItemData[],
        newlyExtractedItemsThisRun: ItemData[],
        urlsScannedThisRun: number,
        pagesProcessedThisRun: number,
    ) {
        const { slug, prompt } = createItemsGeneratorDto;
        this.logger.log(`[${slug}] Starting data aggregation and deduplication.`);

        // Track metrics
        let newItemsAddedToStoreCount = 0;

        // Deduplicate by fields first (faster than AI)
        this.logger.log(`[${slug}] Deduplicating items by fields`);
        let deduplicated = this.sharedUtils.deduplicateByField(
            this.sharedUtils.deduplicateByField(newlyExtractedItemsThisRun, 'slug'),
            'source_url',
        );

        this.logger.log(
            `[${slug}] Field-based deduplication: ${newlyExtractedItemsThisRun.length} → ${deduplicated.length} items`,
        );

        // Extract new items (if we have existing items)
        if (existingItems.length > 0 && deduplicated.length > 0) {
            this.logger.log(`[${slug}] Extracting new items.`);
            const previousCount = deduplicated.length;

            deduplicated = await this.newItemsExtractor.extractNewItems(
                existingItems,
                deduplicated,
            );
            newItemsAddedToStoreCount = deduplicated.length;

            this.logger.log(
                `[${slug}] New items extraction: ${previousCount} → ${newItemsAddedToStoreCount} items`,
            );
        }

        // Deduplicate with AI (more sophisticated)
        if (deduplicated.length > 0) {
            this.logger.log(`[${slug}] Deduplicating items with AI.`);
            deduplicated = await this.aiDeduplicator.deduplicateWithAI(prompt, deduplicated);
            this.logger.log(
                `[${slug}] AI-based deduplication: ${deduplicated.length} items remaining`,
            );
        }

        // Calculate metrics
        const metrics: ItemsGeneratorMetrics = {
            urls_scanned: urlsScannedThisRun,
            pages_processed: pagesProcessedThisRun,
            items_extracted_current_run: newlyExtractedItemsThisRun.length,
            new_items_added_to_store: newItemsAddedToStoreCount,
            total_items_in_store: deduplicated.length,
        };

        this.logger.log(
            `[${slug}] Data aggregation and deduplication complete. Final item count: ${deduplicated.length}`,
        );

        return { aggregatedItems: deduplicated, metrics };
    }
}

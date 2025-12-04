import { Injectable, Logger } from '@nestjs/common';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { ItemsGeneratorMetrics } from '../dto/items-generator-response.dto';
import { ItemData } from '../dto';
import {
    SharedUtilsService,
    NewItemsExtractorService,
    AiDeduplicatorService,
} from './data-aggregation';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';

type DataAggregationParams = {
    directorySlug: string;
    createItemsGeneratorDto: CreateItemsGeneratorDto;
    existingItems: ItemData[];
    newlyExtractedItemsThisRun: ItemData[];
    urlsScannedThisRun: number;
    pagesProcessedThisRun: number;
};

@Injectable()
export class DataAggregationService implements IPipelineStep {
    private readonly logger = new Logger(DataAggregationService.name);

    public readonly name = ItemsGeneratorStep.DEDUPLICATION_AND_DATA_AGGREGATION;

    constructor(
        private readonly sharedUtils: SharedUtilsService,
        private readonly newItemsExtractor: NewItemsExtractorService,
        private readonly aiDeduplicator: AiDeduplicatorService,
    ) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, existing, initialAiItems, extractedWebItems, webPages } = context;

        // Combine AI-generated items and web-extracted items
        const allDiscoveredItems = [...initialAiItems, ...extractedWebItems];
        this.logger.log(
            `[${directory.slug}] Total discovered items (AI + Web before source validation): ${allDiscoveredItems.length}.`,
        );

        this.logger.log(`[${directory.slug}] Deduplication and Data Aggregation - Starting`);

        const { aggregatedItems, metrics } = await this.aggregateAndDeduplicateData({
            directorySlug: directory.slug,
            createItemsGeneratorDto: dto,
            existingItems: existing.existingItems || [],
            urlsScannedThisRun: webPages.length, // approximate, initially scanned = retrieved
            newlyExtractedItemsThisRun: allDiscoveredItems,
            pagesProcessedThisRun: webPages.length,
        });

        context.aggregatedItems = aggregatedItems;
        context.metrics = metrics;

        return context;
    }

    /**
     * Aggregates and deduplicates data from multiple sources
     */
    async aggregateAndDeduplicateData({
        directorySlug,
        createItemsGeneratorDto,
        existingItems,
        newlyExtractedItemsThisRun,
        urlsScannedThisRun,
        pagesProcessedThisRun,
    }: DataAggregationParams) {
        const { prompt } = createItemsGeneratorDto;

        this.logger.log(`[${directorySlug}] Starting data aggregation and deduplication.`);

        // Track metrics
        let newItemsAddedToStoreCount = 0;

        // Deduplicate by fields first (faster than AI)
        this.logger.log(`[${directorySlug}] Deduplicating items by fields`);
        let deduplicated = this.sharedUtils.deduplicateByField(
            this.sharedUtils.deduplicateByField(newlyExtractedItemsThisRun, 'slug'),
            'source_url',
        );

        this.logger.log(
            `[${directorySlug}] Field-based deduplication: ${newlyExtractedItemsThisRun.length} → ${deduplicated.length} items`,
        );

        // Extract new items (if we have existing items)
        if (existingItems.length > 0 && deduplicated.length > 0) {
            this.logger.log(`[${directorySlug}] Extracting new items.`);
            const previousCount = deduplicated.length;

            deduplicated = await this.newItemsExtractor.extractNewItems(
                existingItems,
                deduplicated,
            );
            newItemsAddedToStoreCount = deduplicated.length;

            this.logger.log(
                `[${directorySlug}] New items extraction: ${previousCount} → ${newItemsAddedToStoreCount} items`,
            );
        }

        // Deduplicate with AI (more sophisticated)
        if (deduplicated.length > 0) {
            this.logger.log(`[${directorySlug}] Deduplicating items with AI.`);
            deduplicated = await this.aiDeduplicator.deduplicateWithAI(prompt, deduplicated);
            this.logger.log(
                `[${directorySlug}] AI-based deduplication: ${deduplicated.length} items remaining`,
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
            `[${directorySlug}] Data aggregation and deduplication complete. Final item count: ${deduplicated.length}`,
        );

        return { aggregatedItems: deduplicated, metrics };
    }
}

import type {
	IBuiltInStepExecutor,
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	MutableItemData
} from '@ever-works/plugin';
import { SharedUtilsService, NewItemsExtractorService, AiDeduplicatorService } from './data-aggregation/index.js';

/**
 * Data Aggregation Step
 *
 * Aggregates and deduplicates data from multiple sources (AI-generated items
 * and web-extracted items). Uses both field-based and AI-based deduplication
 * for comprehensive duplicate removal.
 */
export class DataAggregationStep implements IBuiltInStepExecutor {
	readonly name = 'Deduplication and Data Aggregation';

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, existing, initialAiItems, extractedWebItems, webPages, advancedPrompts, metrics } =
			context;
		const { logger } = execContext;

		// Combine AI-generated items and web-extracted items
		const allDiscoveredItems = [...initialAiItems, ...extractedWebItems];
		logger.debug(
			`[${directory.slug}] Total discovered items (AI + Web before source validation): ${allDiscoveredItems.length}.`
		);

		logger.log(`[${directory.slug}] Deduplication and Data Aggregation - Starting`);

		const { aggregatedItems, updatedMetrics } = await this.aggregateAndDeduplicateData(
			directory.slug,
			request.prompt || '',
			request.config || {},
			(existing.items as MutableItemData[]) || [],
			allDiscoveredItems,
			webPages.length, // approximate, initially scanned = retrieved
			metrics,
			advancedPrompts?.deduplication,
			execContext
		);

		context.aggregatedItems = aggregatedItems;

		// Update metrics
		if (updatedMetrics) {
			context.metrics = {
				...context.metrics,
				...updatedMetrics
			};
		}

		return context;
	}

	/**
	 * Aggregates and deduplicates data from multiple sources
	 */
	private async aggregateAndDeduplicateData(
		directorySlug: string,
		prompt: string,
		config: Record<string, unknown>,
		existingItems: MutableItemData[],
		newlyExtractedItemsThisRun: MutableItemData[],
		pagesProcessedThisRun: number,
		metrics: PipelineMetrics,
		customPrompt: string | null | undefined,
		execContext: StepExecutionContext
	): Promise<{ aggregatedItems: MutableItemData[]; updatedMetrics: Partial<PipelineMetrics> }> {
		const { logger } = execContext;

		// Create utility instances
		const sharedUtils = new SharedUtilsService(logger);
		const newItemsExtractor = new NewItemsExtractorService(execContext, sharedUtils);
		const aiDeduplicator = new AiDeduplicatorService(execContext, sharedUtils);

		logger.debug(`[${directorySlug}] Starting data aggregation and deduplication.`);

		// Track metrics
		let newItemsAddedToStoreCount = 0;

		// Deduplicate by fields first (faster than AI)
		logger.debug(`[${directorySlug}] Deduplicating items by fields`);
		let deduplicated = sharedUtils.deduplicateByField(
			sharedUtils.deduplicateByField(newlyExtractedItemsThisRun, 'slug'),
			'source_url'
		);

		logger.log(
			`[${directorySlug}] Field-based deduplication: ${newlyExtractedItemsThisRun.length} → ${deduplicated.length} items`
		);

		// Extract new items (if we have existing items)
		if (existingItems.length > 0 && deduplicated.length > 0) {
			logger.debug(`[${directorySlug}] Extracting new items.`);
			const previousCount = deduplicated.length;

			deduplicated = await newItemsExtractor.extractNewItems(existingItems, deduplicated, metrics);
			newItemsAddedToStoreCount = deduplicated.length;

			logger.log(
				`[${directorySlug}] New items extraction: ${previousCount} → ${newItemsAddedToStoreCount} items`
			);
		}

		// Deduplicate with AI (more sophisticated)
		if (deduplicated.length > 0) {
			logger.debug(`[${directorySlug}] Deduplicating items with AI.`);
			deduplicated = await aiDeduplicator.deduplicateWithAI(prompt, deduplicated, metrics, customPrompt);
			logger.log(`[${directorySlug}] AI-based deduplication: ${deduplicated.length} items remaining`);
		}

		// Apply max_items limit if specified (for sample mode or explicit limit)
		const maxItems = config.max_items as number | undefined;
		if (maxItems && deduplicated.length > maxItems) {
			logger.log(`[${directorySlug}] Applying max_items limit: ${deduplicated.length} → ${maxItems} items`);
			deduplicated = deduplicated.slice(0, maxItems);
		}

		// Calculate final output metrics
		const updatedMetrics: Partial<PipelineMetrics> = {
			urlsExtracted: pagesProcessedThisRun,
			pagesRetrieved: pagesProcessedThisRun,
			itemsExtracted: newlyExtractedItemsThisRun.length,
			itemsAfterDedup: deduplicated.length
		};

		logger.log(
			`[${directorySlug}] Data aggregation and deduplication complete. Final item count: ${deduplicated.length}`
		);

		return { aggregatedItems: deduplicated, updatedMetrics };
	}
}

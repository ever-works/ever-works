import type {
	IBuiltInStepExecutor,
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	MutableItemData,
	DataSourceFilterContext,
	IAiFacade
} from '@ever-works/plugin';
import { z } from 'zod';
import { SharedUtilsService, NewItemsExtractorService, AiDeduplicatorService } from './data-aggregation/index.js';

/**
 * Data Aggregation Step
 *
 * Aggregates and deduplicates data from multiple sources (AI-generated items,
 * web-extracted items, and external data sources). Uses both field-based and
 * AI-based deduplication for comprehensive duplicate removal.
 */
export class DataAggregationStep implements IBuiltInStepExecutor {
	readonly name = 'Deduplication and Data Aggregation';

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const {
			request,
			directory,
			existing,
			initialAiItems,
			extractedWebItems,
			webPages,
			advancedPrompts,
			metrics,
			pluginConfig
		} = context;
		const { logger, dataSourceFacade } = execContext;

		// Combine AI-generated items and web-extracted items
		let allDiscoveredItems = [...initialAiItems, ...extractedWebItems];
		logger.debug(
			`[${directory.slug}] Total discovered items (AI + Web before source validation): ${allDiscoveredItems.length}.`
		);

		// Query external data sources if facade is available and configured
		if (dataSourceFacade?.isConfigured()) {
			try {
				// Extract keywords using AI for multilingual support
				const keywords = await this.extractKeywords(request.prompt, context.subject, execContext.aiFacade);

				// Build filter context for per-plugin relevance filtering
				const filterContext: DataSourceFilterContext = {
					prompt: request.prompt,
					subject: context.subject,
					keywords
				};

				const result = await dataSourceFacade.queryAll({
					directoryId: directory.id,
					userId: directory.user?.id,
					pluginConfig: pluginConfig,
					filterContext: filterContext
				});

				if (result.items.length > 0) {
					logger.log(`[${directory.slug}] External data sources returned ${result.items.length} items`);
					allDiscoveredItems = [...allDiscoveredItems, ...result.items];
				}

				// Log any errors from data sources
				for (const err of result.errors) {
					logger.warn(`[${directory.slug}] Data source ${err.sourceId} failed: ${err.error}`);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				logger.warn(`[${directory.slug}] Data source query failed: ${errorMessage}`);
			}
		}

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

	/**
	 * Extracts keywords from prompt and subject for relevance filtering.
	 * Uses AI for multilingual support when available, falls back to simple extraction.
	 */
	private async extractKeywords(prompt?: string, subject?: string, aiFacade?: IAiFacade): Promise<readonly string[]> {
		// If no text to extract from, return empty
		if (!prompt && !subject) {
			return [];
		}

		// Try AI extraction for multilingual support
		if (aiFacade?.isConfigured() && prompt) {
			try {
				const { result } = await aiFacade.askJson(
					`Extract 5-10 key search terms/keywords from this text that would help identify relevant items.
Include the main topic, key concepts, and important terms.
Support any language - extract keywords in the same language as the input.

Text: "${prompt}"
${subject ? `Subject: "${subject}"` : ''}

Return only meaningful keywords, no common words or articles.`,
					z.object({
						keywords: z.array(z.string()).describe('Extracted keywords and key phrases')
					}),
					{
						routing: { complexity: 'simple', taskId: 'keyword-extraction' }
					}
				);

				if (result.keywords && result.keywords.length > 0) {
					// Add subject if provided and not already in keywords
					const allKeywords = subject
						? [subject.toLowerCase(), ...result.keywords.map((k: string) => k.toLowerCase())]
						: result.keywords.map((k: string) => k.toLowerCase());

					return [...new Set(allKeywords)];
				}
			} catch {
				// Fall through to simple extraction on AI failure
			}
		}

		// Fallback: Simple extraction (works for any language, just splits on whitespace)
		const keywords: string[] = [];

		if (subject) {
			keywords.push(subject.toLowerCase());
		}

		if (prompt) {
			// Simple extraction: split by whitespace, filter short words
			// This works for any language since we don't rely on language-specific stop words
			const words = prompt
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 2); // Shorter threshold for multilingual support
			keywords.push(...words.slice(0, 10));
		}

		return [...new Set(keywords)];
	}
}

import { z } from 'zod';
import type { MutableItemData, StepExecutionContext, PipelineMetrics, FacadeOptions } from '@ever-works/plugin';
import { slugifyText } from '../../utils/text.utils.js';
import { getErrorMessage, getErrorStack } from '../../utils/error.utils.js';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas.js';
import { SharedUtils } from './shared-utils.js';
import { EXTRACT_NEW_ITEMS_PROMPT } from './prompts.constants.js';

// Inferred type from schema
type ExtractedItems = z.infer<typeof extractedItemsSchema>;

/**
 * New Items Extractor
 *
 * Extracts new items that don't exist in the existing items list.
 * Uses AI for sophisticated duplicate detection.
 */
export class NewItemsExtractor {
	private readonly logger: StepExecutionContext['logger'];
	private readonly aiFacade: StepExecutionContext['aiFacade'];
	private readonly sharedUtils: SharedUtils;
	private readonly facadeOptions: FacadeOptions;

	constructor(execContext: StepExecutionContext, sharedUtils: SharedUtils) {
		this.logger = execContext.logger;
		this.aiFacade = execContext.aiFacade;
		this.sharedUtils = sharedUtils;
		this.facadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};
	}

	/**
	 * Extracts new items that don't exist in the existing items
	 * @param existingItems Existing items
	 * @param newItems New items to filter
	 * @param metrics Pipeline metrics for tracking
	 */
	async extractNewItems(
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		if (!newItems || newItems.length === 0) return [];
		if (!existingItems || existingItems.length === 0) return newItems;

		this.logger.log(
			`Starting new items extraction: comparing ${newItems.length} new items against ${existingItems.length} existing items`
		);

		// Phase 1: Fast manual deduplication using multiple strategies
		const manuallyFiltered = this.sharedUtils.filterNewItemsManually(existingItems, newItems);

		const manualFilteredCount = newItems.length - manuallyFiltered.length;
		this.logger.log(
			`Manual deduplication removed ${manualFilteredCount} duplicates, ${manuallyFiltered.length} items remain for AI processing`
		);

		// If no items remain after manual filtering, return empty array
		if (manuallyFiltered.length === 0) {
			this.logger.log(
				`Completed new items extraction: ${newItems.length} items → 0 new items (manual filtering only)`
			);
			return [];
		}

		// Phase 2: AI-based deduplication for remaining items
		// For small arrays, process directly
		if (manuallyFiltered.length <= this.sharedUtils.MAX_CLUSTER_SIZE) {
			const result = await this.processSingleExtractionBatch(existingItems, manuallyFiltered, metrics);
			this.logger.log(
				`Completed new items extraction: ${newItems.length} items → ${result.length} new items (through AI processing)`
			);
			return result;
		}

		// For large arrays, use a chunking strategy
		return this.processLargeExtractionArray(existingItems, manuallyFiltered, metrics);
	}

	/**
	 * Process a single batch of items for extraction
	 * @param existingItems Existing items
	 * @param newItems New items to filter
	 * @param metrics Pipeline metrics
	 */
	private async processSingleExtractionBatch(
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		try {
			// Find only relevant existing items to reduce AI payload
			const relevantExistingItems = this.sharedUtils.findRelevantExistingItems(
				newItems,
				existingItems,
				40 // Limit to 40 most relevant existing items
			);

			this.logger.debug(
				`AI processing: comparing ${newItems.length} new items against ${relevantExistingItems.length} relevant existing items`
			);

			const { result, usage, cost } = await this.aiFacade.askJson<ExtractedItems>(
				EXTRACT_NEW_ITEMS_PROMPT,
				extractedItemsSchema,
				{
					temperature: 0,
					variables: {
						existing: JSON.stringify(relevantExistingItems.map((item) => this.sharedUtils.itemMap(item))),
						new: JSON.stringify(newItems.map((item) => this.sharedUtils.itemMap(item)))
					},
					routing: {
						complexity: 'medium',
						taskId: 'new-items-extraction'
					}
				},
				this.facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return (result?.items || []).map((item) => {
				return {
					...item,
					slug: slugifyText(item.name),
					category: '',
					tags: [],
					featured: item.featured ?? undefined
				} as MutableItemData;
			});
		} catch (error) {
			this.logger.error(
				`Error during new items extraction batch: ${getErrorMessage(error)}`,
				getErrorStack(error)
			);

			return newItems;
		}
	}

	/**
	 * Process a large array of items for extraction using a chunking strategy
	 * @param existingItems Existing items
	 * @param newItems New items to filter
	 * @param metrics Pipeline metrics
	 */
	private async processLargeExtractionArray(
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		// Group similar items by name similarity to create more efficient chunks
		const groupedItems = this.sharedUtils.groupSimilarItems(newItems);
		this.logger.log(
			`Grouped ${newItems.length} new items into ${groupedItems.length} clusters for efficient processing`
		);

		const relevantExistingItems = this.sharedUtils.findRelevantExistingItems(
			newItems,
			existingItems,
			70 // Limit to 70 most relevant existing items for large batches
		);

		this.logger.log(
			`Pre-filtered existing items: ${relevantExistingItems.length} relevant items (from ${existingItems.length} total) will be used for AI comparison`
		);

		// Process each group in manageable chunks
		const CHUNK_SIZE = this.sharedUtils.MAX_CLUSTER_SIZE;
		let extractedItems: MutableItemData[] = [];
		let totalProcessed = 0;

		// Process each group
		for (let groupIndex = 0; groupIndex < groupedItems.length; groupIndex++) {
			const group = groupedItems[groupIndex];

			if (!group || group.length === 0) continue;

			// Process large groups in chunks
			if (group.length > CHUNK_SIZE) {
				// Process the group in chunks
				const chunks = this.sharedUtils.chunkArray(group, CHUNK_SIZE);
				let extractedChunks: MutableItemData[] = [];

				// Process each chunk
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i];
					this.logger.debug(
						`Processing group ${groupIndex + 1}/${groupedItems.length}, chunk ${i + 1}/${chunks.length} (${chunk.length} items)`
					);

					const extractedChunk = await this.processSingleExtractionBatchWithRelevantItems(
						relevantExistingItems,
						chunk,
						metrics
					);
					extractedChunks = extractedChunks.concat(extractedChunk);

					totalProcessed += chunk.length;
					this.logger.log(`Progress: ${totalProcessed}/${newItems.length} items processed`);

					// Add a small delay between chunks to avoid rate limiting
					if (i < chunks.length - 1) {
						await this.sharedUtils.addProcessingDelay(500);
					}
				}

				extractedItems = extractedItems.concat(extractedChunks);
			} else {
				// Process small groups directly
				this.logger.debug(`Processing group ${groupIndex + 1}/${groupedItems.length} (${group.length} items)`);
				const extractedGroup = await this.processSingleExtractionBatchWithRelevantItems(
					relevantExistingItems,
					group,
					metrics
				);
				extractedItems = extractedItems.concat(extractedGroup);

				totalProcessed += group.length;
			}

			// Add a small delay between groups to avoid rate limiting
			if (groupIndex < groupedItems.length - 1) {
				await this.sharedUtils.addProcessingDelay(1000);
			}
		}

		this.logger.log(
			`Completed new items extraction: ${newItems.length} items → ${extractedItems.length} new items`
		);

		return extractedItems;
	}

	/**
	 * Process a single batch of items for extraction with pre-filtered relevant existing items
	 * @param relevantExistingItems Pre-filtered relevant existing items
	 * @param newItems New items to filter
	 * @param metrics Pipeline metrics
	 */
	private async processSingleExtractionBatchWithRelevantItems(
		relevantExistingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		try {
			const { result, usage, cost } = await this.aiFacade.askJson<ExtractedItems>(
				EXTRACT_NEW_ITEMS_PROMPT,
				extractedItemsSchema,
				{
					temperature: 0,
					variables: {
						existing: JSON.stringify(relevantExistingItems.map((item) => this.sharedUtils.itemMap(item))),
						new: JSON.stringify(newItems.map((item) => this.sharedUtils.itemMap(item)))
					},
					routing: {
						complexity: 'medium',
						taskId: 'new-items-extraction-batch'
					}
				},
				this.facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return (result?.items || []).map((item) => {
				return {
					...item,
					slug: slugifyText(item.name),
					category: '',
					tags: [],
					featured: item.featured ?? undefined
				} as MutableItemData;
			});
		} catch (error) {
			this.logger.error(
				`Error during new items extraction batch: ${getErrorMessage(error)}`,
				getErrorStack(error)
			);

			return newItems;
		}
	}

	/**
	 * Accumulate token usage and cost metrics
	 */
	private accumulateMetrics(
		metrics: PipelineMetrics,
		usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
		cost: number | null
	): void {
		if (!metrics.steps) {
			metrics.steps = {};
		}
		if (!metrics.steps['new-items-extraction']) {
			metrics.steps['new-items-extraction'] = {
				name: 'New Items Extraction',
				startTime: Date.now(),
				success: true
			};
		}
		const stepMetrics = metrics.steps['new-items-extraction'];
		if (!stepMetrics.custom) {
			stepMetrics.custom = {};
		}
		if (usage) {
			stepMetrics.custom.totalTokens = ((stepMetrics.custom.totalTokens as number) || 0) + usage.totalTokens;
		}
		if (cost) {
			stepMetrics.custom.totalCost = ((stepMetrics.custom.totalCost as number) || 0) + cost;
		}
	}
}

import { z } from 'zod';
import type { MutableItemData, StepExecutionContext, PipelineMetrics, FacadeOptions } from '@ever-works/plugin';
import { filterNewItemsManually } from '@ever-works/plugin';
import { slugifyText } from '../../utils/text.utils.js';
import { getErrorMessage, getErrorStack } from '../../utils/error.utils.js';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas.js';
import { MAX_CLUSTER_SIZE, chunkArray, groupSimilarItems, findRelevantExistingItems } from './clustering.js';
import { EXTRACT_NEW_ITEMS_PROMPT } from './prompts.constants.js';

type ExtractedItems = z.infer<typeof extractedItemsSchema>;

export class NewItemsExtractor {
	private readonly logger: StepExecutionContext['logger'];
	private readonly aiFacade: StepExecutionContext['aiFacade'];
	private readonly facadeOptions: FacadeOptions;

	constructor(execContext: StepExecutionContext) {
		this.logger = execContext.logger;
		this.aiFacade = execContext.aiFacade;
		this.facadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};
	}

	async extractNewItems(
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		if (!newItems || newItems.length === 0) return [];
		if (!existingItems || existingItems.length === 0) return newItems;

		this.logger.log(`Starting new items extraction: ${newItems.length} new vs ${existingItems.length} existing`);

		// Phase 1: Fast field-based dedup
		const manuallyFiltered = filterNewItemsManually(existingItems, newItems);
		const removedCount = newItems.length - manuallyFiltered.length;
		this.logger.log(`Manual dedup removed ${removedCount}, ${manuallyFiltered.length} remain for AI`);

		if (manuallyFiltered.length === 0) {
			this.logger.log(`New items extraction: ${newItems.length} → 0 (manual filtering only)`);
			return [];
		}

		// Phase 2: AI-based dedup
		if (manuallyFiltered.length <= MAX_CLUSTER_SIZE) {
			const result = await this.processSingleBatch(existingItems, manuallyFiltered, metrics);
			this.logger.log(`New items extraction: ${newItems.length} → ${result.length}`);
			return result;
		}

		return this.processLargeArray(existingItems, manuallyFiltered, metrics);
	}

	private async processSingleBatch(
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		try {
			const relevant = findRelevantExistingItems(newItems, existingItems, 40);
			this.logger.debug(`AI comparing ${newItems.length} new vs ${relevant.length} relevant existing`);

			const { result, usage, cost } = await this.aiFacade.askJson<ExtractedItems>(
				EXTRACT_NEW_ITEMS_PROMPT,
				extractedItemsSchema,
				{
					temperature: 0,
					variables: {
						existing: JSON.stringify(relevant.map((i) => ({ ...i }))),
						new: JSON.stringify(newItems.map((i) => ({ ...i })))
					},
					routing: { complexity: 'medium', taskId: 'new-items-extraction' }
				},
				this.facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return (result?.items || []).map(
				(item) =>
					({
						...item,
						slug: slugifyText(item.name),
						category: '',
						tags: [],
						featured: item.featured ?? undefined
					}) as MutableItemData
			);
		} catch (error) {
			this.logger.error(`Error during new items extraction: ${getErrorMessage(error)}`, getErrorStack(error));
			return newItems;
		}
	}

	private async processLargeArray(
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		metrics: PipelineMetrics
	): Promise<MutableItemData[]> {
		const groups = groupSimilarItems(newItems, this.logger);
		this.logger.log(`Grouped ${newItems.length} new items into ${groups.length} clusters`);

		const relevant = findRelevantExistingItems(newItems, existingItems, 70);
		this.logger.log(`Using ${relevant.length} relevant existing items (from ${existingItems.length} total)`);

		let extractedItems: MutableItemData[] = [];
		let totalProcessed = 0;

		for (let gi = 0; gi < groups.length; gi++) {
			const group = groups[gi];
			if (!group || group.length === 0) continue;

			if (group.length > MAX_CLUSTER_SIZE) {
				const chunks = chunkArray(group, MAX_CLUSTER_SIZE);

				for (let ci = 0; ci < chunks.length; ci++) {
					this.logger.debug(
						`Processing group ${gi + 1}/${groups.length}, chunk ${ci + 1}/${chunks.length} (${chunks[ci].length} items)`
					);
					const extracted = await this.processBatchWithRelevant(relevant, chunks[ci], metrics);
					extractedItems = extractedItems.concat(extracted);
					totalProcessed += chunks[ci].length;
					this.logger.log(`Progress: ${totalProcessed}/${newItems.length} items processed`);

					if (ci < chunks.length - 1) await this.delay(500);
				}
			} else {
				this.logger.debug(`Processing group ${gi + 1}/${groups.length} (${group.length} items)`);
				const extracted = await this.processBatchWithRelevant(relevant, group, metrics);
				extractedItems = extractedItems.concat(extracted);
				totalProcessed += group.length;
			}

			if (gi < groups.length - 1) await this.delay(1000);
		}

		this.logger.log(`New items extraction: ${newItems.length} → ${extractedItems.length}`);
		return extractedItems;
	}

	private async processBatchWithRelevant(
		relevantExisting: MutableItemData[],
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
						existing: JSON.stringify(relevantExisting.map((i) => ({ ...i }))),
						new: JSON.stringify(newItems.map((i) => ({ ...i })))
					},
					routing: { complexity: 'medium', taskId: 'new-items-extraction-batch' }
				},
				this.facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return (result?.items || []).map(
				(item) =>
					({
						...item,
						slug: slugifyText(item.name),
						category: '',
						tags: [],
						featured: item.featured ?? undefined
					}) as MutableItemData
			);
		} catch (error) {
			this.logger.error(`Error during extraction batch: ${getErrorMessage(error)}`, getErrorStack(error));
			return newItems;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private accumulateMetrics(
		metrics: PipelineMetrics,
		usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
		cost: number | null
	): void {
		if (!metrics.steps) metrics.steps = {};
		if (!metrics.steps['new-items-extraction']) {
			metrics.steps['new-items-extraction'] = {
				name: 'New Items Extraction',
				startTime: Date.now(),
				success: true
			};
		}
		const step = metrics.steps['new-items-extraction'];
		if (!step.custom) step.custom = {};
		if (usage) step.custom.totalTokens = ((step.custom.totalTokens as number) || 0) + usage.totalTokens;
		if (cost) step.custom.totalCost = ((step.custom.totalCost as number) || 0) + cost;
	}
}

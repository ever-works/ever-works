import { z } from 'zod';
import type { MutableItemData, StepExecutionContext, PipelineMetrics, FacadeOptions } from '@ever-works/plugin';
import { slugifyText } from '../../utils/text.utils.js';
import { extractedItemsSchema } from '../../schemas/item-extraction.schemas.js';
import { getErrorMessage, getErrorStack } from '../../utils/error.utils.js';
import { appendCustomPrompt } from '../../utils/prompt.utils.js';
import { MAX_CLUSTER_SIZE, chunkArray, groupSimilarItems } from './clustering.js';
import { DEDUPLICATOR_PROMPT } from './prompts.constants.js';

type ExtractedItems = z.infer<typeof extractedItemsSchema>;

export class AiDeduplicator {
	private readonly CHUNK_DELAY_MS = 500;
	private readonly GROUP_DELAY_MS = 1000;

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

	async deduplicateWithAI(
		description: string,
		items: MutableItemData[],
		metrics: PipelineMetrics,
		customPrompt?: string | null
	): Promise<MutableItemData[]> {
		if (!items || items.length === 0) return [];

		this.logger.log(`Starting AI deduplication for ${items.length} items`);

		if (items.length <= MAX_CLUSTER_SIZE) {
			return this.processSingleBatch(description, items, metrics, customPrompt);
		}

		return this.processLargeArray(description, items, metrics, customPrompt);
	}

	private async processSingleBatch(
		description: string,
		items: MutableItemData[],
		metrics: PipelineMetrics,
		customPrompt?: string | null
	): Promise<MutableItemData[]> {
		try {
			const finalPrompt = appendCustomPrompt(DEDUPLICATOR_PROMPT, customPrompt);
			const { result, usage, cost } = await this.aiFacade.askJson<ExtractedItems>(
				finalPrompt,
				extractedItemsSchema,
				{
					temperature: 0,
					variables: {
						task: description,
						items: JSON.stringify(items.map((item) => ({ ...item })))
					},
					routing: { complexity: 'medium', taskId: 'ai-deduplication' }
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
			this.logger.warn(`Error during AI deduplication batch: ${getErrorMessage(error)}`, getErrorStack(error));
			return items;
		}
	}

	private async processLargeArray(
		description: string,
		items: MutableItemData[],
		metrics: PipelineMetrics,
		customPrompt?: string | null
	): Promise<MutableItemData[]> {
		const startTime = Date.now();
		const groups = groupSimilarItems(items, this.logger);
		this.logger.log(`Grouped ${items.length} items into ${groups.length} clusters`);

		let processedItems: MutableItemData[] = [];
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
					const deduped = await this.processSingleBatch(description, chunks[ci], metrics, customPrompt);
					processedItems = processedItems.concat(deduped);
					totalProcessed += chunks[ci].length;
					this.logger.log(`Progress: ${totalProcessed}/${items.length} items processed`);

					if (ci < chunks.length - 1) await this.delay(this.CHUNK_DELAY_MS);
				}
			} else {
				this.logger.debug(`Processing group ${gi + 1}/${groups.length} (${group.length} items)`);
				const deduped = await this.processSingleBatch(description, group, metrics, customPrompt);
				processedItems = processedItems.concat(deduped);
				totalProcessed += group.length;
			}

			if (gi < groups.length - 1) await this.delay(this.GROUP_DELAY_MS);
		}

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		this.logger.log(`Completed AI deduplication: ${items.length} → ${processedItems.length} items in ${elapsed}s`);

		return processedItems;
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
		if (!metrics.steps['ai-deduplication']) {
			metrics.steps['ai-deduplication'] = { name: 'AI Deduplication', startTime: Date.now(), success: true };
		}
		const step = metrics.steps['ai-deduplication'];
		if (!step.custom) step.custom = {};
		if (usage) step.custom.totalTokens = ((step.custom.totalTokens as number) || 0) + usage.totalTokens;
		if (cost) step.custom.totalCost = ((step.custom.totalCost as number) || 0) + cost;
	}
}

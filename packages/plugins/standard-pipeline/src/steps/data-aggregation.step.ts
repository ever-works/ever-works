import type {
	StepExecutionContext,
	MutableItemData,
	DataSourceFilterContext,
	IAiFacade,
	FacadeOptions
} from '@ever-works/plugin';
import { deduplicateByField, filterNewItemsManually } from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { extractKeywordsFromPrompt } from '@ever-works/plugin/keywords';
import { z } from 'zod';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { NewItemsExtractor, AiDeduplicator } from './data-aggregation/index.js';

export class DataAggregationStep extends BasePipelineStep {
	readonly name = 'Deduplication and Data Aggregation';
	readonly stepId = 'deduplication-and-data-aggregation' as const;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { request, directory, existing, initialAiItems, extractedWebItems, webPages, advancedPrompts, metrics } =
			context;
		const { logger } = execContext;

		const aiWebItems = [...initialAiItems, ...extractedWebItems];
		logger.debug(`[${directory.slug}] AI + Web items before dedup: ${aiWebItems.length}`);
		logger.log(`[${directory.slug}] Deduplication and Data Aggregation - Starting`);

		const existingItems = (existing.items as MutableItemData[]) || [];

		const { aggregatedItems: dedupedAiWebItems, updatedMetrics } = await this.aggregateAndDeduplicateData(
			directory.slug,
			request.prompt || '',
			existingItems,
			aiWebItems,
			webPages.length,
			metrics,
			advancedPrompts?.deduplication,
			execContext
		);

		const dataSourceItems = await this.queryAndDedupDataSources(
			context,
			execContext,
			existingItems,
			dedupedAiWebItems
		);

		let finalItems = [...dedupedAiWebItems, ...dataSourceItems];
		finalItems = this.applyMaxItemsLimit(finalItems, request, directory.slug, logger);

		context.aggregatedItems = finalItems;

		if (finalItems.length === 0) {
			context.shouldStop = true;
			this.addWarning(context, 'No items available after aggregation. The pipeline will stop.');
		}

		if (updatedMetrics) {
			context.metrics = { ...context.metrics, ...updatedMetrics, itemsAfterDedup: finalItems.length };
		}

		return context;
	}

	private async aggregateAndDeduplicateData(
		directorySlug: string,
		prompt: string,
		existingItems: MutableItemData[],
		newItems: MutableItemData[],
		pagesProcessed: number,
		metrics: StandardPipelineMetrics,
		customPrompt: string | null | undefined,
		execContext: StepExecutionContext
	): Promise<{ aggregatedItems: MutableItemData[]; updatedMetrics: Partial<StandardPipelineMetrics> }> {
		const { logger } = execContext;
		const newItemsExtractor = new NewItemsExtractor(execContext);
		const aiDeduplicator = new AiDeduplicator(execContext);

		let deduplicated = deduplicateByField(deduplicateByField(newItems, 'slug'), 'source_url');
		logger.log(`[${directorySlug}] Field-based dedup: ${newItems.length} → ${deduplicated.length}`);

		if (existingItems.length > 0 && deduplicated.length > 0) {
			const prev = deduplicated.length;
			deduplicated = await newItemsExtractor.extractNewItems(existingItems, deduplicated, metrics);
			logger.log(`[${directorySlug}] New items extraction: ${prev} → ${deduplicated.length}`);
		}

		if (deduplicated.length > 0) {
			deduplicated = await aiDeduplicator.deduplicateWithAI(prompt, deduplicated, metrics, customPrompt);
			logger.log(`[${directorySlug}] AI dedup: ${deduplicated.length} items remaining`);
		}

		return {
			aggregatedItems: deduplicated,
			updatedMetrics: {
				urlsExtracted: pagesProcessed,
				pagesRetrieved: pagesProcessed,
				itemsExtracted: newItems.length,
				itemsAfterDedup: deduplicated.length
			}
		};
	}

	private async queryAndDedupDataSources(
		context: MutableGenerationContext,
		execContext: StepExecutionContext,
		existingItems: MutableItemData[],
		dedupedAiWebItems: MutableItemData[]
	): Promise<MutableItemData[]> {
		const { dataSourceFacade, logger } = execContext;
		if (!dataSourceFacade?.isConfigured()) return [];

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		try {
			const keywords = await this.extractKeywords(
				context.request.prompt,
				context.subject,
				execContext.aiFacade,
				facadeOptions
			);
			const filterContext: DataSourceFilterContext = {
				prompt: context.request.prompt,
				subject: context.subject,
				keywords
			};

			const result = await dataSourceFacade.queryAll({
				directoryId: context.directory.id,
				userId: execContext.user!.id,
				pluginConfig: context.pluginConfig,
				filterContext
			});

			for (const err of result.errors) {
				logger.warn(`[${context.directory.slug}] Data source ${err.sourceId} failed: ${err.error}`);
			}

			if (result.items.length === 0) return [];

			logger.log(`[${context.directory.slug}] Data sources returned ${result.items.length} items`);

			const baseline = [...existingItems, ...dedupedAiWebItems];
			const filtered = filterNewItemsManually(baseline, result.items as MutableItemData[]);

			logger.log(
				`[${context.directory.slug}] Data source field-dedup: ${result.items.length} → ${filtered.length} new`
			);
			return filtered;
		} catch (error) {
			logger.warn(
				`[${context.directory.slug}] Data source query failed: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		}
	}

	private applyMaxItemsLimit(
		items: MutableItemData[],
		request: MutableGenerationContext['request'],
		directorySlug: string,
		logger: StepExecutionContext['logger']
	): MutableItemData[] {
		const maxItems = (request.config || {}).max_items as number | undefined;
		if (maxItems && items.length > maxItems) {
			logger.log(`[${directorySlug}] Applying max_items limit: ${items.length} → ${maxItems}`);
			return items.slice(0, maxItems);
		}
		return items;
	}

	private async extractKeywords(
		prompt?: string,
		subject?: string,
		aiFacade?: IAiFacade,
		facadeOptions?: FacadeOptions
	): Promise<readonly string[]> {
		if (!prompt && !subject) return [];

		if (aiFacade?.isConfigured() && prompt) {
			try {
				const { result } = await aiFacade.askJson(
					`Extract 5-10 key search terms/keywords from this text that would help identify relevant items.
Include the main topic, key concepts, and important terms.
Support any language - extract keywords in the same language as the input.

Text: "${prompt}"
${subject ? `Subject: "${subject}"` : ''}

Return only meaningful keywords, no common words or articles.`,
					z.object({ keywords: z.array(z.string()).describe('Extracted keywords and key phrases') }),
					{ routing: { complexity: 'simple', taskId: 'keyword-extraction' } },
					facadeOptions!
				);

				if (result.keywords?.length > 0) {
					const all = subject
						? [subject.toLowerCase(), ...result.keywords.map((k: string) => k.toLowerCase())]
						: result.keywords.map((k: string) => k.toLowerCase());
					return [...new Set(all)];
				}
			} catch {
				// Fall through to simple extraction
			}
		}

		return extractKeywordsFromPrompt(prompt, subject, 10);
	}
}

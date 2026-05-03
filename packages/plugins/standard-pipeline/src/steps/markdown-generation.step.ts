import { z } from 'zod';
import type { StepExecutionContext, MutableItemData, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { getErrorStack } from '../utils/error.utils.js';
import { PROMPT_KEYS } from '../prompt-keys.js';

export const MARKDOWN_PROMPT = `
You are work website builder and your task is to generate markdown summary for item:
<item>
{item}
</item>

<rules>
1. Many websites will contain marketing language, make sure to extract only relevant information.
2. Exclude anything related to Testimonials, "Why Choose" specific product and other marketing / sales details.
3. No need to include any info about "Support" if item is a product.
4. Make sure we output ALL features (as much as possible) of the item inside "Features" block, not only Key Features.
5. If item is a product/service, make sure to include "Pricing" block with all available plans (if provided content contains it).
</rules>

Based on this website content:
<content>
{content}
</content>` as const;

// Output schema for validation
const markdownOutputSchema = z.object({
	markdown: z.string()
});

type MarkdownOutput = z.infer<typeof markdownOutputSchema>;

/**
 * Markdown Generation Step
 *
 * Generates detailed markdown summaries for items based on their source content.
 */
export class MarkdownGenerationStep extends BasePipelineStep {
	readonly name = 'Markdown Generation';
	readonly stepId = 'markdown-generation' as const;
	private readonly BATCH_SIZE = 10;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { work, finalItems, contentCache, metrics } = context;
		const { logger, aiFacade, contentExtractorFacade, promptFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		if (!finalItems || finalItems.length === 0) {
			return context;
		}

		logger.log(`[${work.slug}] Generating markdown for ${finalItems.length} items`);

		const itemsWithMarkdown = await this.generateMarkdownForItems(
			finalItems,
			contentCache,
			metrics,
			logger,
			aiFacade,
			contentExtractorFacade,
			facadeOptions,
			promptFacade
		);

		context.finalItems = itemsWithMarkdown;
		return context;
	}

	/**
	 * Generates markdown summaries for multiple items.
	 * Items without source_url get empty markdown (no hallucination).
	 */
	private async generateMarkdownForItems(
		items: MutableItemData[],
		contentCache: Map<string, string> | undefined,
		metrics: StandardPipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
	): Promise<MutableItemData[]> {
		if (!items || items.length === 0) {
			return [];
		}

		// Separate items: only items with source_url can get AI-generated markdown
		const itemsWithContent = items.filter((item) => item.source_url);
		const itemsWithoutContent = items.filter((item) => !item.source_url);

		if (itemsWithoutContent.length > 0) {
			logger.log(`Skipping markdown generation for ${itemsWithoutContent.length} items without source URLs`);
		}

		const processedItems: MutableItemData[] = [];

		const resolvedPrompt = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.MARKDOWN_GENERATION, MARKDOWN_PROMPT)
				: MARKDOWN_PROMPT
		) as typeof MARKDOWN_PROMPT;

		// Process items with content in batches
		for (let i = 0; i < itemsWithContent.length; i += this.BATCH_SIZE) {
			const batch = itemsWithContent.slice(i, i + this.BATCH_SIZE);

			const markdownPromises = batch.map(async (item) => {
				const markdown = await this.generateMarkdown(
					item,
					contentCache,
					metrics,
					logger,
					aiFacade,
					contentExtractorFacade,
					facadeOptions,
					resolvedPrompt
				);
				return {
					...item,
					markdown
				};
			});

			const batchResults = await Promise.all(markdownPromises);
			processedItems.push(...batchResults);

			if (i + this.BATCH_SIZE < itemsWithContent.length) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		// Items without source content get empty markdown (no hallucination)
		for (const item of itemsWithoutContent) {
			processedItems.push({ ...item, markdown: '' });
		}

		return processedItems;
	}

	/**
	 * Generates markdown summary for a given item
	 */
	private async generateMarkdown(
		item: MutableItemData,
		contentCache: Map<string, string> | undefined,
		metrics: StandardPipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		resolvedPrompt: typeof MARKDOWN_PROMPT
	): Promise<string> {
		if (!item || !item.source_url) {
			logger.warn(`Cannot generate markdown: Missing item or source URL`);
			return '';
		}

		try {
			// Check cache first for content
			let rawContent = contentCache?.get(item.source_url);

			if (!rawContent) {
				// Fall back to fetching if not in cache
				const content = await this.extractContentFrom(
					item.source_url,
					logger,
					contentExtractorFacade,
					facadeOptions
				);
				rawContent = content?.rawContent;
			}

			if (!rawContent) {
				logger.warn(`Failed to get content for: "${item.source_url}"`);
				return '';
			}

			if (!aiFacade.isConfigured()) {
				logger.warn('AI provider not configured, skipping markdown generation');
				return '';
			}

			// Generate markdown using the content
			const { result, usage, cost } = await aiFacade.askJson<MarkdownOutput>(
				resolvedPrompt,
				markdownOutputSchema,
				{
					temperature: 0.6,
					variables: {
						item: JSON.stringify(item),
						content: rawContent.slice(0, 4000)
					},
					routing: {
						complexity: 'simple',
						taskId: 'markdown-generation'
					}
				},
				facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return result.markdown || '';
		} catch (error) {
			logger.error(
				`Error generating markdown for ${item.name}: ${this.formatError(error)}`,
				getErrorStack(error)
			);
			return '';
		}
	}

	/**
	 * Extracts content from a URL using the content extractor facade
	 */
	private async extractContentFrom(
		url: string,
		logger: StepExecutionContext['logger'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions
	): Promise<{ rawContent: string } | null> {
		try {
			const content = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);
			return content ? { rawContent: content.rawContent } : null;
		} catch (error) {
			logger.error(`Error extracting content from ${url}: ${this.formatError(error)}`);
			return null;
		}
	}
}

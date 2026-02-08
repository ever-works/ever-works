import { z } from 'zod';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	MutableItemData,
	FacadeOptions
} from '@ever-works/plugin';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { getErrorStack } from '../utils/error.utils.js';

export const MARKDOWN_PROMPT = `
You are directory website builder and your task is to generate markdown summary for item:
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

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { directory, finalItems, contentCache, metrics } = context;
		const { logger, aiFacade, contentExtractorFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		if (!finalItems || finalItems.length === 0) {
			return context;
		}

		logger.log(`[${directory.slug}] Generating markdown for ${finalItems.length} items`);

		const itemsWithMarkdown = await this.generateMarkdownForItems(
			finalItems,
			contentCache,
			metrics,
			logger,
			aiFacade,
			contentExtractorFacade,
			facadeOptions
		);

		context.finalItems = itemsWithMarkdown;
		return context;
	}

	/**
	 * Generates markdown summaries for multiple items
	 */
	private async generateMarkdownForItems(
		items: MutableItemData[],
		contentCache: Map<string, string> | undefined,
		metrics: PipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions
	): Promise<MutableItemData[]> {
		if (!items || items.length === 0) {
			return [];
		}

		const processedItems: MutableItemData[] = [];

		// Process each batch
		for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
			const batch = items.slice(i, i + this.BATCH_SIZE);

			const markdownPromises = batch.map(async (item) => {
				const markdown = await this.generateMarkdown(
					item,
					contentCache,
					metrics,
					logger,
					aiFacade,
					contentExtractorFacade,
					facadeOptions
				);
				return {
					...item,
					markdown
				};
			});

			const batchResults = await Promise.all(markdownPromises);
			processedItems.push(...batchResults);

			if (i + this.BATCH_SIZE < items.length) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		return processedItems;
	}

	/**
	 * Generates markdown summary for a given item
	 */
	private async generateMarkdown(
		item: MutableItemData,
		contentCache: Map<string, string> | undefined,
		metrics: PipelineMetrics,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions
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
				const content = await this.extractContentFrom(item.source_url, logger, contentExtractorFacade);
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
				MARKDOWN_PROMPT,
				markdownOutputSchema,
				{
					temperature: 0.6,
					variables: {
						item: JSON.stringify(item),
						content: rawContent.slice(0, 4000)
					},
					routing: {
						complexity: 'medium',
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
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade']
	): Promise<{ rawContent: string } | null> {
		try {
			const content = await contentExtractorFacade.extractContent(url);
			return content ? { rawContent: content.rawContent } : null;
		} catch (error) {
			logger.error(`Error extracting content from ${url}: ${this.formatError(error)}`);
			return null;
		}
	}
}

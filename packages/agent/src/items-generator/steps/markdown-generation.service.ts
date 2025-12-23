import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService, TaskComplexity } from 'src/ai';
import { SearchService } from '../shared';
import { ItemData } from '../dto';
import { accumulateMetrics, MetricsAccumulator } from '../utils/metrics.util';
import { getErrorMessage, getErrorStack } from '../utils/error.util';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';

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
export const markdownOutputSchema = z.object({
    markdown: z.string(),
});

@Injectable()
export class MarkdownGenerationService implements IPipelineStep {
    private readonly logger = new Logger(MarkdownGenerationService.name);
    public readonly name = ItemsGeneratorStep.MARKDOWN_GENERATION;

    constructor(
        private readonly aiService: AiService,
        private readonly searchService: SearchService,
    ) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { directory, finalItems, contentCache, metrics } = context;

        if (!finalItems || finalItems.length === 0) {
            return context;
        }

        this.logger.log(`[${directory.slug}] Generating markdown for ${finalItems.length} items`);

        const itemsWithMarkdown = await this.generateMarkdownForItems(
            finalItems,
            contentCache,
            metrics,
        );

        context.finalItems = itemsWithMarkdown;
        return context;
    }

    /**
     * Generates markdown summary for a given item
     * @param item The item to generate markdown for
     * @param contentCache Optional cache of source_url -> raw_content to avoid refetching
     * @returns A markdown string with the item's summary
     */
    async generateMarkdown(
        item: Partial<ItemData>,
        contentCache?: Map<string, string>,
        metrics?: MetricsAccumulator,
    ): Promise<string> {
        if (!item || !item.source_url) {
            this.logger.warn(`Cannot generate markdown: Missing item or source URL`);
            return '';
        }

        this.logger.log(`Generating markdown for: ${item.name} (${item.slug})`);

        try {
            // Check cache first for content
            let rawContent = contentCache?.get(item.source_url);

            if (!rawContent) {
                // Fall back to fetching if not in cache
                const content = await this.extractContentFrom(item.source_url);
                rawContent = content?.rawContent;
            } else {
                this.logger.debug(`Using cached content for: ${item.source_url}`);
            }

            if (!rawContent) {
                this.logger.warn(`Failed to get content for: "${item.source_url}"`);
                return '';
            }

            // Generate markdown using the content
            const { result, usage, cost } = await this.aiService.askJson(
                MARKDOWN_PROMPT,
                markdownOutputSchema,
                {
                    temperature: 0.6,
                    variables: {
                        item: JSON.stringify(item),
                        content: rawContent.slice(0, 4000),
                    },
                    routing: {
                        complexity: TaskComplexity.COMPLEX,
                        taskId: 'markdown-generation',
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            return result.markdown || '';
        } catch (error) {
            this.logger.error(
                `Error generating markdown for ${item.name}: ${getErrorMessage(error)}`,
                getErrorStack(error),
            );
            return '';
        }
    }

    /**
     * Generates markdown summaries for multiple items
     * @param items The items to generate markdown for
     * @param contentCache Optional cache of source_url -> raw_content to avoid refetching
     * @returns An array of items with their markdown summaries
     */
    async generateMarkdownForItems(
        items: ItemData[],
        contentCache?: Map<string, string>,
        metrics?: MetricsAccumulator,
    ): Promise<ItemData[]> {
        if (!items || items.length === 0) {
            return [];
        }

        this.logger.log(`Generating markdown for ${items.length} items`);

        // Process items in batches
        const BATCH_SIZE = 10;
        const processedItems: ItemData[] = [];

        // Process each batch
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);

            const markdownPromises = batch.map(async (item) => {
                const markdown = await this.generateMarkdown(item, contentCache, metrics);
                return {
                    ...item,
                    markdown,
                };
            });

            const batchResults = await Promise.all(markdownPromises);
            processedItems.push(...batchResults);

            if (i + BATCH_SIZE < items.length) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        return processedItems;
    }

    /**
     * Extracts content from a URL using the search service
     * @param url The URL to extract content from
     * @returns The extracted content
     */
    private async extractContentFrom(url: string) {
        this.logger.log(`Extracting content from ${url}`);

        try {
            return await this.searchService.extractContent(url);
        } catch (error) {
            // try again with extractContentUsingLocal
            const text = await this.searchService.extractContentUsingLocal(url).catch(() => null);

            if (text) {
                return {
                    rawContent: text,
                };
            }

            this.logger.error(
                `Error extracting content from ${url}: ${error.message}`,
                error.stack,
            );
            return null;
        }
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService, BaseChatModel } from 'src/ai';
import { SearchService } from '../shared';
import { ItemData } from '../dto';

// Markdown generation prompt
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
</content>`;

// Output schema for validation
export const markdownOutputSchema = z.object({
    markdown: z.string(),
});

@Injectable()
export class MarkdownGenerationService {
    private readonly logger = new Logger(MarkdownGenerationService.name);
    private llm: BaseChatModel;

    constructor(
        private readonly aiService: AiService,
        private readonly searchService: SearchService,
    ) {
        this.llm = this.aiService.createLlmWithTemperature(0.6);
    }

    /**
     * Generates markdown summary for a given item
     * @param item The item to generate markdown for
     * @returns A markdown string with the item's summary
     */
    async generateMarkdown(item: Partial<ItemData>): Promise<string> {
        if (!item || !item.source_url) {
            this.logger.warn(`Cannot generate markdown: Missing item or source URL`);
            return '';
        }

        this.logger.log(`Generating markdown for: ${item.name} (${item.slug})`);

        try {
            // Extract content from the source URL
            const content = await this.extractContentFrom(item.source_url);

            if (!content || !content.rawContent) {
                this.logger.warn(`Failed to extract content from: "${item.source_url}"`);
                return '';
            }

            // Generate markdown using the extracted content
            const prompt = HumanMessagePromptTemplate.fromTemplate(MARKDOWN_PROMPT);
            const result = await prompt
                .pipe(this.llm.withStructuredOutput(markdownOutputSchema))
                .invoke({
                    item: JSON.stringify(item),
                    content: content.rawContent.slice(0, 4000),
                });

            return result.markdown || '';
        } catch (error) {
            this.logger.error(
                `Error generating markdown for ${item.name}: ${error.message}`,
                error.stack,
            );
            return '';
        }
    }

    /**
     * Generates markdown summaries for multiple items
     * @param items The items to generate markdown for
     * @returns An array of items with their markdown summaries
     */
    async generateMarkdownForItems(items: ItemData[]): Promise<ItemData[]> {
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
                const markdown = await this.generateMarkdown(item);
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
            // try again with extractContentUsingNaive
            const text = await this.searchService.extractContentUsingNaive(url).catch(() => null);

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

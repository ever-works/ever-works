import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { ItemData, Category, Tag, CreateItemsGeneratorDto } from '../dto';
import { slugifyText } from '../utils/text.utils';
import { AiService } from '../shared';
import { itemDataWithCategoriesAndTagsSchema } from '../schemas/item-extraction.schemas';

// Prompt for categorization
const CATEGORIZE_PROMPT = `
You are a directory website builder and your task is to categorize items based on their features and descriptions.

<task>
{task}
</task>

Here is the list of items to categorize:
<items>
{items}
</items>

<instructions>
1. **Task Analysis**: First, analyze the task description above to determine your categorization approach:
   - If the task contains specific categorization instructions, category preferences, or tag requirements, follow those guidelines
   - If the task doesn't specify categorization details, analyze the items themselves to determine appropriate categories based on their types, functions, and purposes
   - Look for any domain context, target audience, or industry focus mentioned in the task

2. **Category Assignment**: Assign each item to ONE appropriate category based on:
   - Any specific categories mentioned or implied in the task description
   - If no specific categories are mentioned, group items by their primary function or purpose
   - Ensure categories are consistent and at a similar level of abstraction
   - For software/tools, good category examples include: "Monitoring", "CI/CD", "Data Visualization", "Testing", etc.

3. **Tag Assignment**: Assign 2-5 relevant tags to each item that:
   - Include any specific tags or keywords mentioned in the task description
   - If no specific tags are mentioned, highlight key features, technologies, or use cases
   - Align with the domain context provided in the task (if any)
   - For tags, good examples include: "open-source", "real-time", "cloud-native", "enterprise", etc.

4. **Fallback Categorization** (when task has no specific categorization guidance):
   - Analyze the items to identify common patterns and group similar items together
   - Create categories based on the primary function, technology type, or use case of the items
   - Ensure categories are meaningful and help users find related items easily

5. **General Guidelines**:
   - Avoid overly broad categories like "Tools" or "Software" - be more specific
   - Avoid overly specific categories that would only contain 1-2 items
   - Maintain consistency across similar items
   - If the task emphasizes certain aspects (e.g., "open-source", "enterprise"), reflect this in your categorization
</instructions>
`.trim();

// Output schema for validation
const categorizeOutputSchema = z.object({
    items: z.array(itemDataWithCategoriesAndTagsSchema),
});

@Injectable()
export class CategoryProcessingService {
    private readonly logger = new Logger(CategoryProcessingService.name);
    private llm: ChatOpenAI;

    constructor(private readonly aiService: AiService) {
        this.llm = this.aiService.createLlmWithTemperature(0.3);
    }

    /**
     * Process items to generate categories and tags
     * @param createItemsGeneratorDto The DTO containing the prompt
     * @param extractedItems The items to categorize
     * @param existingCategories Existing categories to maintain consistency
     * @param existingTags Existing tags to maintain consistency
     * @param initialCategories Categories provided initially (from DTO or prompt)
     */
    async processCategoriesAndTags(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        extractedItems: Partial<ItemData>[],
        existingCategories: Category[],
        existingTags: Tag[],
        initialCategories: string[] = [],
    ) {
        const { slug, prompt } = createItemsGeneratorDto;
        this.logger.log(
            `[${slug}] Starting category and tag processing for ${extractedItems.length} items`,
        );

        // Track metrics
        const startTime = Date.now();

        if (!extractedItems || extractedItems.length === 0) {
            this.logger.log(`[${slug}] No items to categorize`);
            return { finalItems: [], categories: [], tags: [] };
        }

        // Convert existing categories and tags to sets for easy lookup
        const existingCategoriesSet: Set<string> = new Set();
        const existingTagsSet: Set<string> = new Set();

        existingCategories.forEach((category) => existingCategoriesSet.add(category.name));
        existingTags.forEach((tag) => existingTagsSet.add(tag.name));

        // Add initial categories to existing categories for prioritization
        initialCategories.forEach((category) => existingCategoriesSet.add(category));

        try {
            // Categorize items using AI
            const categorized = await this.categorizeItems(
                prompt,
                extractedItems,
                existingCategoriesSet,
                existingTagsSet,
            );

            this.logger.log(`[${slug}] Successfully categorized ${categorized.length} items`);

            // Extract unique categories and tags
            const categories = this.extractUniqueCategories(categorized);
            const tags = this.extractUniqueTags(categorized);

            // Convert to final format
            const finalItems = categorized.map((item) => this.toItemData(item));

            // Calculate processing time
            const processingTime = (Date.now() - startTime) / 1000;
            this.logger.log(
                `[${slug}] Category processing complete in ${processingTime.toFixed(2)}s. Found ${categories.length} categories and ${tags.length} tags.`,
            );

            return { finalItems, categories, tags };
        } catch (error) {
            this.logger.error(
                `[${slug}] Error during category processing: ${error.message}`,
                error.stack,
            );

            // Fallback: assign default category and no tags
            const defaultCategory = { id: 'others', name: 'Others' };
            const finalItems = extractedItems.map((item) => ({
                ...item,
                tags: [],
                category: 'others',
                slug: item.slug || slugifyText(item.name),
            })) as ItemData[];

            return {
                finalItems,
                categories: [defaultCategory],
                tags: [],
            };
        }
    }

    /**
     * Categorize items using AI
     * @param description Description of the directory
     * @param items Items to categorize
     */
    private async categorizeItems(
        description: string,
        items: Partial<ItemData>[],
        existingCategories: Set<string>,
        existingTags: Set<string>,
    ): Promise<ItemData[]> {
        if (!items || items.length === 0) return [];

        try {
            // Prepare items for categorization
            const itemsForCategorization = items.map((i) => ({
                slug: i.slug,
                name: i.name,
                description: i.description,
                source_url: i.source_url,
            }));

            // Process in batches if there are many items
            if (items.length > 50) {
                return this.processBatchCategorization(
                    description,
                    itemsForCategorization,
                    existingCategories,
                    existingTags,
                );
            }

            // Format existing categories and tags for the prompt
            const categoriesText = Array.from(existingCategories).join(', ');
            const tagsText = Array.from(existingTags).join(', ');

            // Use the enhanced prompt if we have existing categories/tags, otherwise use the basic prompt
            const promptTemplate = this.enhancedPrompt(existingCategories, existingTags);

            // Process all items at once if the count is reasonable
            const prompt = HumanMessagePromptTemplate.fromTemplate(promptTemplate);
            const result = await prompt
                .pipe(this.llm.withStructuredOutput(categorizeOutputSchema))
                .invoke({
                    task: description,
                    items: JSON.stringify(itemsForCategorization),
                    existing_categories: categoriesText,
                    existing_tags: tagsText,
                });

            return result.items as ItemData[];
        } catch (error) {
            this.logger.error(`Error during AI categorization: ${error.message}`, error.stack);

            // Fallback to items with default category and tags
            return items.map((item) => ({
                ...item,
                tags: [],
                category: 'others',
                slug: item.slug || slugifyText(item.name),
            })) as ItemData[];
        }
    }

    /**
     * Generate an enhanced prompt that includes existing categories and tags
     */
    private enhancedPrompt(existingCategories: Set<string>, existingTags: Set<string>) {
        if (!existingCategories.size && !existingTags.size) {
            return CATEGORIZE_PROMPT;
        }

        const enhancedPromptTemplate = `
${CATEGORIZE_PROMPT}

<existing_categories>
{existing_categories}
</existing_categories>

<existing_tags>
{existing_tags}
</existing_tags>

<additional_instructions>
- For consistency, consider using the existing categories and tags listed above when appropriate.
- PRIORITIZE using existing categories that match the items' purposes.
- You can create new categories or tags if the existing ones don't fit well.
- Prioritize consistency across items that serve similar purposes.
- If an item clearly fits into one of the existing categories, use that category rather than creating a new one.
</additional_instructions>
`.trim();

        return enhancedPromptTemplate;
    }

    /**
     * Process items in batches for categorization
     * @param description Description of the directory
     * @param items Items to categorize
     */
    private async processBatchCategorization(
        description: string,
        items: any[],
        existingCategories: Set<string>,
        existingTags: Set<string>,
    ): Promise<ItemData[]> {
        const BATCH_SIZE = 30;
        const allCategorizedItems: ItemData[] = [];

        // Process items in batches
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(items.length / BATCH_SIZE);

            this.logger.log(
                `Processing batch ${batchNumber} of ${totalBatches} (${batch.length} items)`,
            );

            try {
                // Format existing categories and tags for the prompt
                const categoriesText = Array.from(existingCategories).join(', ');
                const tagsText = Array.from(existingTags).join(', ');

                // Use the enhanced prompt if we have existing categories/tags, otherwise use the basic prompt
                const promptTemplate = this.enhancedPrompt(existingCategories, existingTags);

                const prompt = HumanMessagePromptTemplate.fromTemplate(promptTemplate);
                const result = await prompt
                    .pipe(this.llm.withStructuredOutput(categorizeOutputSchema))
                    .invoke({
                        task: description,
                        items: JSON.stringify(batch),
                        existing_categories: categoriesText,
                        existing_tags: tagsText,
                    });

                const batchResults = result.items as ItemData[];

                // Extract and store categories and tags from this batch for future batches
                batchResults.forEach((item) => {
                    if (item.category && typeof item.category === 'string') {
                        existingCategories.add(item.category);
                    }

                    if (Array.isArray(item.tags)) {
                        item.tags.forEach((tag: any) => {
                            if (typeof tag === 'string') {
                                existingTags.add(tag);
                            }
                        });
                    }
                });

                this.logger.log(
                    `Batch ${batchNumber} complete. Found ${batchResults.length} categorized items. ` +
                        `Running totals: ${existingCategories.size} categories, ${existingTags.size} tags.`,
                );

                allCategorizedItems.push(...batchResults);

                // Add a small delay between batches to avoid rate limiting
                if (i + BATCH_SIZE < items.length) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            } catch (error) {
                this.logger.error(
                    `Error during batch categorization: ${error.message}`,
                    error.stack,
                );

                // Fallback for this batch - use existing categories if available
                const fallbackCategory =
                    existingCategories.size > 0 ? Array.from(existingCategories)[0] : 'others';

                const fallbackItems = batch.map((item) => ({
                    ...item,
                    category: fallbackCategory,
                    tags: [],
                    slug: item.slug || slugifyText(item.name),
                })) as ItemData[];

                allCategorizedItems.push(...fallbackItems);
            }
        }

        // Final consistency pass to normalize categories and tags
        return this.normalizeCategorizationResults(allCategorizedItems);
    }

    /**
     * Normalize categorization results for consistency
     * @param items Categorized items
     */
    private normalizeCategorizationResults(items: ItemData[]): ItemData[] {
        // Count category and tag frequencies
        const categoryFrequency: Map<string, number> = new Map();

        // Build frequency maps
        items.forEach((item) => {
            // Count categories
            const category = typeof item.category === 'string' ? item.category : '';
            if (category) {
                categoryFrequency.set(category, (categoryFrequency.get(category) || 0) + 1);
            }
        });

        // Filter out rare categories (likely errors or inconsistencies)
        const validCategories = new Set(
            Array.from(categoryFrequency.entries())
                .filter(([_, count]) => count >= 2) // Keep categories with at least 2 occurrences
                .map(([category, _]) => category),
        );

        // If we filtered out all categories, keep at least one
        if (validCategories.size === 0 && categoryFrequency.size > 0) {
            // Find the most frequent category
            const mostFrequentCategory = Array.from(categoryFrequency.entries()).sort(
                (a, b) => b[1] - a[1],
            )[0][0];
            validCategories.add(mostFrequentCategory);
        }

        // Default category if needed
        const defaultCategory =
            validCategories.size > 0 ? Array.from(validCategories)[0] : 'others';

        // Normalize items
        return items.map((item) => {
            const category = typeof item.category === 'string' ? item.category : '';

            return {
                ...item,
                // Use the category if it's valid, otherwise use the default
                category: validCategories.has(category) ? category : defaultCategory,
            };
        });
    }

    /**
     * Extract unique categories from categorized items
     * @param items Categorized items
     */
    private extractUniqueCategories(items: ItemData[]): Category[] {
        const categoryNames = items.map((item) =>
            typeof item.category === 'string' ? item.category : item.category?.name,
        );
        return this.mapUnique(categoryNames);
    }

    /**
     * Extract unique tags from categorized items
     * @param items Categorized items
     */
    private extractUniqueTags(items: ItemData[]): Tag[] {
        const tagNames = items.flatMap((item) => item.tags as string[]);
        return this.mapUnique(tagNames);
    }

    /**
     * Map an array of names to unique identifiable objects
     * @param names Array of names
     */
    private mapUnique(names: string[]): Array<{ id: string; name: string }> {
        const unique = new Set(names.filter(Boolean));
        return Array.from(unique).map((name) => ({
            id: slugifyText(name),
            name,
        }));
    }

    /**
     * Convert a partial item to a full ItemData object
     * @param item Partial item data
     */
    private toItemData(item: Partial<ItemData>): ItemData {
        return {
            name: item.name,
            description: item.description,
            source_url: item.source_url,
            category: slugifyText(item.category as string),
            tags: Array.isArray(item.tags)
                ? item.tags.map((tag: any) => slugifyText(typeof tag === 'string' ? tag : tag.name))
                : [],
            slug: item.slug || slugifyText(item.name),
        };
    }
}

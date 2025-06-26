import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { ItemData, Category, Tag, CreateItemsGeneratorDto } from '../dto';
import { slugifyText } from '../utils/text.utils';
import { AiService } from '../shared';
import { itemDataWithCategoriesAndTagsSchema } from '../schemas/item-extraction.schemas';
import { BaseChatModel } from '../shared/ai-provider.interface';

// Prompt for categorization
const categoryPrompt = <T extends string>(additionalContext?: T) =>
    `
You are directory website builder and your task is to Categorize the given items following these rules and task context.

<rules>
1. Assign ONE category per item based on primary function
2. Add 1-3 relevant tags per item
3. Make sure the existing categories and tags are used appropriately before creating new ones (if available).
4. Category divergence is preferable for better grouping of items and directory websites.
5. The user may provide category hints based on the task context, but you are not limited to these unless explicitly and clearly instructed to use only the provided categories.
6. Use domain-specific categories (e.g. "open-source projects", "enterprise software", "cloud services")
7. Avoid duplicate categories (e.g. "Monitoring" and "Monitoring Tools", "Open-source" and "Open Source Projects")
8. Use descriptive tags (e.g. "open-source", "real-time", "cloud-native")
9. Avoid unnecessary category suffixes
10. Maintain consistency with existing categories and tags
11. Override any existing item category if it doesn't match the primary task context
12. The featured field should remain the same as in the original item
13. Please give careful consideration to the rules outlined in the <additional_rules> section below (if available).
</rules>

${additionalContext || ''}

Task context:
<task>
{task}
</task>

Items to categorize:
<items>
{items}
</items>` as const;

// Output schema for validation
const categorizeOutputSchema = z.object({
    items: z.array(itemDataWithCategoriesAndTagsSchema),
});

@Injectable()
export class CategoryProcessingService {
    private readonly logger = new Logger(CategoryProcessingService.name);
    private llm: BaseChatModel;
    private readonly BATCH_SIZE = 30;

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
    async processCategoriesAndTags({
        createItemsGeneratorDto,
        extractedItems,
        existingCategories,
        existingTags,
        initialCategories = [],
        existingItems,
    }: {
        createItemsGeneratorDto: CreateItemsGeneratorDto;
        extractedItems: Partial<ItemData>[];
        initialCategories: string[];
        existingCategories: Category[];
        existingTags: Tag[];
        existingItems: ItemData[];
    }) {
        const { slug, prompt, priority_categories = [] } = createItemsGeneratorDto;
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

        // Initial category metrics
        const initialCategoryMetrics: Record<string, number> = {
            total_items: existingItems.length,
        };

        initialCategories.forEach((category) => {
            initialCategoryMetrics[category] = 0;
        });

        existingItems.forEach((item) => {
            const category = typeof item.category === 'string' ? item.category : '';
            if (!category) return;
            initialCategoryMetrics[category] = (initialCategoryMetrics[category] || 0) + 1;
        });

        try {
            // Categorize items using AI
            const categorized = await this.categorizeItems({
                prompt,
                items: extractedItems,
                existingCategories: existingCategoriesSet,
                existingTags: existingTagsSet,
                initialCategoryMetrics,
            });

            this.logger.log(`[${slug}] Successfully categorized ${categorized.length} items`);

            // Extract unique categories and tags
            const categories = this.extractUniqueCategories(categorized, priority_categories);
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
     * @param prompt The prompt to use for categorization
     * @param items Items to categorize
     */
    private async categorizeItems({
        prompt,
        items,
        existingCategories,
        existingTags,
        initialCategoryMetrics,
    }: {
        prompt: string;
        items: Partial<ItemData>[];
        existingCategories: Set<string>;
        existingTags: Set<string>;
        initialCategoryMetrics: Record<string, number>;
    }): Promise<ItemData[]> {
        if (!items || items.length === 0) return [];

        try {
            // Prepare items for categorization
            const itemsForCategorization = items;

            // Process in batches if there are many items
            if (items.length > this.BATCH_SIZE) {
                return this.processBatchCategorization({
                    prompt: prompt,
                    items: itemsForCategorization,
                    existingCategories,
                    existingTags,
                    initialCategoryMetrics,
                });
            }

            // Format existing categories and tags for the prompt
            const categoriesText = Array.from(existingCategories).join(', ');
            const tagsText = Array.from(existingTags).join(', ');

            // Use the enhanced prompt if we have existing categories/tags, otherwise use the basic prompt
            const promptTemplate = this.enhancedPrompt(existingCategories, existingTags);

            // Process all items at once if the count is reasonable
            const result = await HumanMessagePromptTemplate.fromTemplate(promptTemplate)
                .pipe(this.llm.withStructuredOutput(categorizeOutputSchema))
                .invoke({
                    task: prompt,
                    items: JSON.stringify(itemsForCategorization),
                    existing_categories: categoriesText,
                    existing_tags: tagsText,
                    category_metrics: JSON.stringify(initialCategoryMetrics),
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
    private enhancedPrompt<T extends boolean = false>(
        existingCategories: Set<string>,
        existingTags: Set<string>,
    ) {
        const defaultPrompt = categoryPrompt();

        const enhancedPromptTemplate = categoryPrompt(
            `
<additional_rules>
- For consistency, use the existing categories and tags listed below whenever appropriate.
- The category metrics (if provided) can help you understand the distribution of items across categories. 
    - This insight can guide you in deciding when to create new categories to prevent any single category from becoming too large or imbalanced.
    - The metrics provide the total number of items that need to be categorized. Based on this information, you should determine whether a category is too large or imbalanced, and create new categories as needed.
    - You are not limited to the provided existing categories, feel free to create new ones if necessary.
- Prioritize consistency across items with similar purposes.
</additional_rules>

<existing_categories>
{existing_categories}
</existing_categories>

<existing_tags>
{existing_tags}
</existing_tags>

<category_metrics>
{category_metrics}
</category_metrics>
` as const,
        );

        type Returned = T extends true ? typeof enhancedPromptTemplate : typeof defaultPrompt;

        if (!existingCategories.size && !existingTags.size) {
            return defaultPrompt.trim() as Returned;
        }

        return enhancedPromptTemplate.trim() as Returned;
    }

    /**
     * Process items in batches for categorization
     * @param prompt The prompt to use for categorization
     * @param items Items to categorize
     */
    private async processBatchCategorization({
        prompt,
        items,
        existingCategories,
        existingTags,
        initialCategoryMetrics,
    }: {
        prompt: string;
        items: Partial<ItemData>[];
        existingCategories: Set<string>;
        existingTags: Set<string>;
        initialCategoryMetrics: Record<string, number>;
    }): Promise<ItemData[]> {
        const allCategorizedItems: ItemData[] = [];

        // Process items in batches
        for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
            const batch = items.slice(i, i + this.BATCH_SIZE);
            const batchNumber = Math.floor(i / this.BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(items.length / this.BATCH_SIZE);

            this.logger.log(
                `Processing batch ${batchNumber} of ${totalBatches} (${batch.length} items)`,
            );

            try {
                // Format existing categories and tags for the prompt
                const categoriesText = Array.from(existingCategories).join(', ');
                const tagsText = Array.from(existingTags).join(', ');

                // Format categories metrics for the prompt
                const total_items = initialCategoryMetrics.total_items || 0;
                const categoryMetrics: Record<string, number> = {
                    ...initialCategoryMetrics,
                    categorized_items: total_items + allCategorizedItems.length,
                    total_items: total_items + items.length,
                };
                allCategorizedItems.forEach((item) => {
                    const category = typeof item.category === 'string' ? item.category : '';
                    if (!category) return;
                    categoryMetrics[category] = (categoryMetrics[category] || 0) + 1;
                });

                // Use the enhanced prompt if we have existing categories/tags, otherwise use the basic prompt
                const promptTemplate = this.enhancedPrompt<true>(existingCategories, existingTags);

                const result = await HumanMessagePromptTemplate.fromTemplate(promptTemplate)
                    .pipe(this.llm.withStructuredOutput(categorizeOutputSchema))
                    .invoke({
                        task: prompt,
                        items: JSON.stringify(batch),
                        category_metrics: JSON.stringify(categoryMetrics),
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
                    `Batch ${batchNumber} complete. Category metrics: ${JSON.stringify(categoryMetrics)} ` +
                        `Existing tags count: ${existingTags.size}`,
                );

                allCategorizedItems.push(...batchResults);

                // Add a small delay between batches to avoid rate limiting
                if (i + this.BATCH_SIZE < items.length) {
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
     * @param priorityCategories Categories that should appear first in the final output
     */
    private extractUniqueCategories(
        items: ItemData[],
        priorityCategories: string[] = [],
    ): Category[] {
        const categoryNames = items.map((item) =>
            typeof item.category === 'string' ? item.category : item.category?.name,
        );
        return this.mapUniqueWithPriority(categoryNames, priorityCategories);
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
     * Map an array of names to unique identifiable objects with priority support
     * @param names Array of names
     * @param priorityCategories Categories that should appear first (lower priority numbers)
     */
    private mapUniqueWithPriority(names: string[], priorityCategories: string[] = []): Category[] {
        const unique = new Set(names.filter(Boolean));
        const categories: Category[] = [];

        // Create a map of priority category names to their priority order
        const priorityMap = new Map<string, number>();
        priorityCategories.forEach((categoryName, index) => {
            priorityMap.set(categoryName.toLowerCase(), index + 1); // Priority 1, 2, 3, etc.
        });

        // Convert to Category objects with priority
        Array.from(unique).forEach((name) => {
            const priority = priorityMap.get(name.toLowerCase());
            categories.push({
                id: slugifyText(name),
                name,
                priority,
            });
        });

        // Sort categories: priority categories first (by priority order), then alphabetically
        return categories.sort((a, b) => {
            // If both have priority, sort by priority number (lower = higher priority)
            if (a.priority !== undefined && b.priority !== undefined) {
                return a.priority - b.priority;
            }
            // If only a has priority, a comes first
            if (a.priority !== undefined && b.priority === undefined) {
                return -1;
            }
            // If only b has priority, b comes first
            if (a.priority === undefined && b.priority !== undefined) {
                return 1;
            }
            // If neither has priority, sort alphabetically
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * Convert a partial item to a full ItemData object
     * @param item Partial item data
     */
    private toItemData(item: Partial<ItemData>): ItemData {
        return {
            ...(item as ItemData),
            category: slugifyText(item.category as string),
            tags: Array.isArray(item.tags)
                ? item.tags.map((tag: any) => slugifyText(typeof tag === 'string' ? tag : tag.name))
                : [],
            slug: item.slug || slugifyText(item.name),
        };
    }
}

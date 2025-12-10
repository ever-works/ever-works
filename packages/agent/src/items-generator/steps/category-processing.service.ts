import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ItemData, Category, Tag, CreateItemsGeneratorDto, Brand } from '../dto';
import { slugifyText, unSlugifyText } from '../utils/text.utils';
import { getErrorMessage, getErrorStack } from '../utils/error.util';
import { AiService } from 'src/ai';
import { itemDataWithCategoriesAndTagsSchema } from '../schemas/item-extraction.schemas';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { accumulateMetrics, MetricsAccumulator } from '../utils/metrics.util';

// Base prompt for categorization
const CATEGORY_PROMPT =
    `You are directory website builder and your task is to Categorize the given items following these rules and task context.

<rules>
1. Assign ONE category per item based on primary function
2. Add 1-3 relevant tags per item
3. Category divergence is preferable for better grouping of items.
4. You can create new categories in addition to the existing ones when the current categories become too large, while maintaining consistency.
5. A category is too large if it contains more than 50 items.
6. The user may provide category hints based on the task context, but you are not limited to these unless explicitly and clearly instructed to use only the provided categories.
7. Use domain-specific categories (e.g. "open-source projects", "enterprise software", "cloud services")
8. Avoid duplicate categories (e.g. "Monitoring" and "Monitoring Tools", "Open-source" and "Open Source Projects")
9. Use descriptive tags (e.g. "open-source", "real-time", "cloud-native")
10. Avoid unnecessary category suffixes
11. Maintain consistency with existing categories and tags
12. Override any existing item category if it doesn't match the primary task context
13. The featured field should remain the same as in the original item
14. Preserve the original brand when provided (at most one per item) and keep any brand_logo_url if already set. Do not invent brands when the source is unclear.
15. Preserve any item images array; do not discard valid URLs.
16. Please give careful consideration to the rules outlined in the <additional_rules> section below (if available).
</rules>

Task context:
<task>
{task}
</task>

Items to categorize:
<items>
{items}
</items>` as const;

// Enhanced prompt with existing categories/tags context
const ENHANCED_CATEGORY_PROMPT =
    `You are directory website builder and your task is to Categorize the given items following these rules and task context.

<rules>
1. Assign ONE category per item based on primary function
2. Add 1-3 relevant tags per item
3. Category divergence is preferable for better grouping of items.
4. You can create new categories in addition to the existing ones when the current categories become too large, while maintaining consistency.
5. A category is too large if it contains more than 50 items.
6. The user may provide category hints based on the task context, but you are not limited to these unless explicitly and clearly instructed to use only the provided categories.
7. Use domain-specific categories (e.g. "open-source projects", "enterprise software", "cloud services")
8. Avoid duplicate categories (e.g. "Monitoring" and "Monitoring Tools", "Open-source" and "Open Source Projects")
9. Use descriptive tags (e.g. "open-source", "real-time", "cloud-native")
10. Avoid unnecessary category suffixes
11. Maintain consistency with existing categories and tags
12. Override any existing item category if it doesn't match the primary task context
13. The featured field should remain the same as in the original item
14. Preserve the original brand when provided (at most one per item) and keep any brand_logo_url if already set. Do not invent brands when the source is unclear.
15. Preserve any item images array; do not discard valid URLs.
16. Please give careful consideration to the rules outlined in the <additional_rules> section below (if available).
</rules>

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

type CategoryProcessingParams = {
    directorySlug: string;
    createItemsGeneratorDto: CreateItemsGeneratorDto;
    extractedItems: Partial<ItemData>[];
    initialCategories: string[];
    existingCategories: Category[];
    existingTags: Tag[];
    existingItems: ItemData[];
    existingBrands?: Brand[];
    metrics?: MetricsAccumulator;
};

@Injectable()
export class CategoryProcessingService implements IPipelineStep {
    private readonly logger = new Logger(CategoryProcessingService.name);
    private readonly BATCH_SIZE = 30;

    public readonly name = ItemsGeneratorStep.CATEGORIES_TAGS_PROCESSING;

    constructor(private readonly aiService: AiService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const {
            dto,
            directory,
            existing,
            aggregatedItems,
            allInitialCategories,
            allPriorityCategories,
            metrics,
        } = context;

        this.logger.log(`[${directory.slug}] Category and Tag Generation - Starting`);

        // Create a modified DTO with merged priority categories
        const dtoWithMergedPriorities = {
            ...dto,
            priority_categories: allPriorityCategories,
        };

        const { categories, tags, brands, finalItems } = await this.processCategoriesAndTags({
            directorySlug: directory.slug,
            createItemsGeneratorDto: dtoWithMergedPriorities,
            extractedItems: aggregatedItems,
            existingCategories: existing.existingCategories || [],
            existingTags: existing.existingTags || [],
            initialCategories: allInitialCategories,
            existingItems: existing.existingItems,
            existingBrands: existing.existingBrands,
            metrics,
        });

        this.logger.log(
            `[${directory.slug}] Directory data generation complete. Final metrics: ${JSON.stringify(metrics)}`,
        );

        context.finalItems = finalItems;
        context.finalCategories = categories;
        context.finalTags = tags;
        context.finalBrands = brands;

        return context;
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
        directorySlug,
        createItemsGeneratorDto,
        extractedItems,
        existingCategories,
        existingTags,
        initialCategories = [],
        existingItems,
        existingBrands = [],
        metrics,
    }: CategoryProcessingParams) {
        const { prompt, priority_categories = [] } = createItemsGeneratorDto;

        this.logger.log(
            `[${directorySlug}] Starting category and tag processing for ${extractedItems.length} items`,
        );

        // Track metrics
        const startTime = Date.now();

        if (!extractedItems || extractedItems.length === 0) {
            this.logger.log(`[${directorySlug}] No items to categorize`);
            return { finalItems: [], categories: [], tags: [], brands: [] };
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
                metrics,
            });

            this.logger.log(
                `[${directorySlug}] Successfully categorized ${categorized.length} items`,
            );

            // Extract unique categories and tags
            const categories = this.extractUniqueCategories(categorized, priority_categories);
            const tags = this.extractUniqueTags(categorized);
            const brands = this.extractUniqueBrands(categorized, existingBrands);

            // Convert to final format
            const finalItems = categorized.map((item) => this.toItemData(item));

            // Calculate processing time
            const processingTime = (Date.now() - startTime) / 1000;
            this.logger.log(
                `[${directorySlug}] Category processing complete in ${processingTime.toFixed(2)}s. Found ${categories.length} categories and ${tags.length} tags.`,
            );

            return { finalItems, categories, tags, brands };
        } catch (error) {
            this.logger.error(
                `[${directorySlug}] Error during category processing: ${getErrorMessage(error)}`,
                getErrorStack(error),
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
                brands: [],
            };
        }
    }

    /**
     * Categorize items using AI
     * @param prompt The prompt to use for categorization
     * @param items Items to categorize
     * @param metrics Metrics accumulator for token tracking
     */
    private async categorizeItems({
        prompt,
        items,
        existingCategories,
        existingTags,
        initialCategoryMetrics,
        metrics,
    }: {
        prompt: string;
        items: Partial<ItemData>[];
        existingCategories: Set<string>;
        existingTags: Set<string>;
        initialCategoryMetrics: Record<string, number>;
        metrics?: MetricsAccumulator;
    }): Promise<ItemData[]> {
        if (!items || items.length === 0) return [];

        try {
            // Process in batches if there are many items
            if (items.length > this.BATCH_SIZE) {
                return this.processBatchCategorization({
                    prompt,
                    items,
                    existingCategories,
                    existingTags,
                    initialCategoryMetrics,
                    metrics,
                });
            }

            // Format existing categories and tags for the prompt
            const categoriesText = Array.from(existingCategories).join(', ');
            const tagsText = Array.from(existingTags).join(', ');

            // Use enhanced prompt if we have existing categories/tags
            const hasContext = existingCategories.size > 0 || existingTags.size > 0;

            const { result, usage, cost } = hasContext
                ? await this.aiService.askJson(ENHANCED_CATEGORY_PROMPT, categorizeOutputSchema, {
                      temperature: 0.3,
                      variables: {
                          task: prompt,
                          items: JSON.stringify(items),
                          existing_categories: categoriesText,
                          existing_tags: tagsText,
                          category_metrics: JSON.stringify(initialCategoryMetrics),
                      },
                  })
                : await this.aiService.askJson(CATEGORY_PROMPT, categorizeOutputSchema, {
                      temperature: 0.3,
                      variables: {
                          task: prompt,
                          items: JSON.stringify(items),
                      },
                  });

            accumulateMetrics(metrics, usage, cost);
            return result.items as ItemData[];
        } catch (error) {
            this.logger.error(
                `Error during AI categorization: ${getErrorMessage(error)}`,
                getErrorStack(error),
            );

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
     * Process items in batches for categorization
     * @param prompt The prompt to use for categorization
     * @param items Items to categorize
     * @param metrics Metrics accumulator for token tracking
     */
    private async processBatchCategorization({
        prompt,
        items,
        existingCategories,
        existingTags,
        initialCategoryMetrics,
        metrics,
    }: {
        prompt: string;
        items: Partial<ItemData>[];
        existingCategories: Set<string>;
        existingTags: Set<string>;
        initialCategoryMetrics: Record<string, number>;
        metrics?: MetricsAccumulator;
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

                // Always use enhanced prompt for batch processing (we always have context)
                const { result, usage, cost } = await this.aiService.askJson(
                    ENHANCED_CATEGORY_PROMPT,
                    categorizeOutputSchema,
                    {
                        temperature: 0.3,
                        variables: {
                            task: prompt,
                            items: JSON.stringify(batch),
                            category_metrics: JSON.stringify(categoryMetrics),
                            existing_categories: categoriesText,
                            existing_tags: tagsText,
                        },
                    },
                );

                accumulateMetrics(metrics, usage, cost);
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
                    `Error during batch categorization: ${getErrorMessage(error)}`,
                    getErrorStack(error),
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
        const categoryNames = items.reduce((acc, item) => {
            if (Array.isArray(item.category)) {
                acc.push(
                    ...(item.category.map((cat) => (typeof cat === 'string' ? cat : cat.name)) ||
                        []),
                );
            } else if (typeof item.category === 'string') {
                acc.push(item.category);
            } else if (item.category?.name) {
                acc.push(item.category.name);
            }

            return acc;
        }, [] as string[]);

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
     * Extract unique brands from categorized items and merge with existing brands when possible
     */
    private extractUniqueBrands(items: ItemData[], existingBrands: Brand[] = []): Brand[] {
        const existingByName = new Map(
            existingBrands.map((brand) => [brand.name.toLowerCase(), brand] as const),
        );

        const brandCandidates: Brand[] = [];

        items.forEach((item) => {
            const brandName =
                typeof item.brand === 'string'
                    ? item.brand
                    : typeof item.brand?.name === 'string'
                      ? item.brand.name
                      : null;

            if (!brandName) {
                return;
            }

            const normalized = brandName.trim();
            const existing = existingByName.get(normalized.toLowerCase());

            const brand_logo_url =
                item.brand && typeof item.brand === 'object'
                    ? item.brand.logo_url
                    : item.brand_logo_url || undefined;

            if (existing) {
                // Preserve existing id/logo when we already have the brand
                brandCandidates.push({
                    ...existing,
                    logo_url: existing.logo_url || brand_logo_url || existing.logo_url,
                });
                return;
            }

            brandCandidates.push({
                id: slugifyText(normalized),
                name: normalized,
                logo_url: brand_logo_url || undefined,
            });
        });

        // Deduplicate by id/name
        const unique = new Map<string, Brand>();
        brandCandidates.forEach((brand) => {
            const key = brand.name.toLowerCase();
            const existing = unique.get(key);
            if (!existing || (!existing.logo_url && brand.logo_url)) {
                unique.set(key, brand);
            }
        });

        return Array.from(unique.values());
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
            priorityMap.set(slugifyText(categoryName), index + 1); // Priority 1, 2, 3, etc.
        });

        // Convert to Category objects with priority
        Array.from(unique).forEach((name) => {
            const priority = priorityMap.get(slugifyText(name));
            categories.push({
                id: slugifyText(name),
                name: unSlugifyText(name),
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
        const brandName =
            typeof item.brand === 'string'
                ? item.brand
                : typeof item.brand?.name === 'string'
                  ? item.brand.name
                  : undefined;
        const brandSlug = brandName ? slugifyText(brandName) : undefined;
        const brandLogoUrl =
            (item.brand && typeof item.brand === 'object' && item.brand.logo_url) ||
            item.brand_logo_url ||
            undefined;

        return {
            ...(item as ItemData),
            category: slugifyText(item.category as string),
            tags: Array.isArray(item.tags)
                ? item.tags.map((tag: any) => slugifyText(typeof tag === 'string' ? tag : tag.name))
                : [],
            slug: item.slug || slugifyText(item.name),
            brand: brandSlug,
            brand_logo_url: brandLogoUrl || null,
        };
    }
}

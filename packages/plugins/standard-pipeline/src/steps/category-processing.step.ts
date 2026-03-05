import { z } from 'zod';
import type {
	StepExecutionContext,
	MutableItemData,
	Category,
	Collection,
	Tag,
	Brand,
	FacadeOptions
} from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { slugifyText, unSlugifyText } from '../utils/text.utils.js';
import { getErrorStack } from '../utils/error.utils.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';
import { PROMPT_KEYS } from '../prompt-keys.js';
import { itemDataWithCategoriesAndTagsSchema } from '../schemas/item-extraction.schemas.js';

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
16. Optionally assign items to at most ONE collection. Collections are curated cross-category lists (e.g., "Editor's Picks", "Best for Beginners", "Top Open Source"). Not every item needs a collection — only assign when genuinely appropriate. Set the collection field to null when not applicable.
17. Please give careful consideration to the rules outlined in the <additional_rules> section below (if available).
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
16. Optionally assign items to at most ONE collection. Collections are curated cross-category lists (e.g., "Editor's Picks", "Best for Beginners", "Top Open Source"). Not every item needs a collection — only assign when genuinely appropriate. Set the collection field to null when not applicable.
17. Please give careful consideration to the rules outlined in the <additional_rules> section below (if available).
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
	items: z.array(itemDataWithCategoriesAndTagsSchema)
});

// Inferred type from schema
type CategorizeResult = z.infer<typeof categorizeOutputSchema>;

/**
 * Category Processing Step
 *
 * Processes items to generate categories, tags, and brands using AI.
 */
export class CategoryProcessingStep extends BasePipelineStep {
	readonly name = 'Categories Tags Processing';
	readonly stepId = 'categories-tags-processing' as const;
	private readonly BATCH_SIZE = 30;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const {
			request,
			directory,
			existing,
			aggregatedItems,
			allInitialCategories,
			allPriorityCategories,
			metrics,
			advancedPrompts
		} = context;
		const { logger } = execContext;

		logger.log(`[${directory.slug}] Category and Tag Generation - Starting`);

		// Check entity generation toggles from config
		const config = request.config || {};
		const generateCategories = config.generate_categories !== false;
		const generateTags = config.generate_tags !== false;
		const generateCollections = config.generate_collections !== false;
		const generateBrands = config.generate_brands !== false;

		// If all entity generation is disabled, skip AI processing entirely
		if (!generateCategories && !generateTags && !generateBrands) {
			logger.log(`[${directory.slug}] All entity generation disabled, assigning default category`);

			const defaultCategory = { id: 'uncategorized', name: 'Uncategorized' };
			const finalItems = aggregatedItems.map((item) => ({
				...item,
				category: 'uncategorized',
				tags: [],
				slug: item.slug || slugifyText(item.name)
			})) as MutableItemData[];

			context.finalItems = finalItems;
			context.finalCategories = [defaultCategory];
			context.finalTags = [];
			context.finalCollections = [];
			context.finalBrands = [];

			return context;
		}

		const { categories, tags, collections, brands, finalItems } = await this.processCategoriesAndTags(
			directory.slug,
			request.prompt || '',
			allPriorityCategories,
			aggregatedItems,
			(existing.categories as Category[]) || [],
			(existing.tags as Tag[]) || [],
			allInitialCategories,
			(existing.items as MutableItemData[]) || [],
			(existing.brands as Brand[]) || [],
			metrics,
			advancedPrompts?.categorization,
			generateCategories,
			generateTags,
			generateCollections,
			generateBrands,
			execContext
		);

		logger.log(`[${directory.slug}] Directory data generation complete. Final metrics: ${JSON.stringify(metrics)}`);

		context.finalItems = finalItems;
		context.finalCategories = categories;
		context.finalTags = tags;
		context.finalCollections = collections;
		context.finalBrands = brands;

		return context;
	}

	/**
	 * Process items to generate categories and tags
	 */
	private async processCategoriesAndTags(
		directorySlug: string,
		prompt: string,
		priorityCategories: string[],
		extractedItems: MutableItemData[],
		existingCategories: Category[],
		existingTags: Tag[],
		initialCategories: string[],
		existingItems: MutableItemData[],
		existingBrands: Brand[],
		metrics: StandardPipelineMetrics,
		customPrompt: string | null | undefined,
		generateCategories: boolean,
		generateTags: boolean,
		generateCollections: boolean,
		generateBrands: boolean,
		execContext: StepExecutionContext
	): Promise<{
		categories: Category[];
		tags: Tag[];
		collections: Collection[];
		brands: Brand[];
		finalItems: MutableItemData[];
	}> {
		const { logger } = execContext;

		logger.log(`[${directorySlug}] Starting category and tag processing for ${extractedItems.length} items`);

		// Track metrics
		const startTime = Date.now();

		if (!extractedItems || extractedItems.length === 0) {
			logger.log(`[${directorySlug}] No items to categorize`);
			return { finalItems: [], categories: [], tags: [], collections: [], brands: [] };
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
			total_items: existingItems.length
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
			let categorized = await this.categorizeItems(
				prompt,
				extractedItems,
				existingCategoriesSet,
				existingTagsSet,
				initialCategoryMetrics,
				metrics,
				customPrompt,
				execContext
			);

			logger.log(`[${directorySlug}] Successfully categorized ${categorized.length} items`);

			// Extract unique categories and tags based on toggle settings
			let categories: Category[];
			let tags: Tag[];
			let collections: Collection[];
			let brands: Brand[];

			if (generateCategories) {
				categories = this.extractUniqueCategories(categorized, priorityCategories);
			} else {
				// Assign default "Uncategorized" category when categories are disabled
				categories = [{ id: 'uncategorized', name: 'Uncategorized' }];
				categorized = categorized.map((item) => ({
					...item,
					category: 'uncategorized'
				})) as MutableItemData[];
			}

			if (generateTags) {
				tags = this.extractUniqueTags(categorized);
			} else {
				tags = [];
				categorized = categorized.map((item) => ({
					...item,
					tags: []
				})) as MutableItemData[];
			}

			if (generateCollections) {
				collections = this.extractUniqueCollections(categorized);
			} else {
				collections = [];
				categorized = categorized.map((item) => ({
					...item,
					collection: undefined
				})) as MutableItemData[];
			}

			if (generateBrands) {
				brands = this.extractUniqueBrands(categorized, existingBrands);
			} else {
				brands = [];
				categorized = categorized.map((item) => ({
					...item,
					brand: undefined,
					brand_logo_url: undefined
				})) as MutableItemData[];
			}

			// Convert to final format
			const finalItems = categorized.map((item) => this.toItemData(item));

			// Calculate processing time
			const processingTime = (Date.now() - startTime) / 1000;
			logger.log(
				`[${directorySlug}] Category processing complete in ${processingTime.toFixed(2)}s. Found ${categories.length} categories, ${tags.length} tags, ${collections.length} collections.`
			);

			return { finalItems, categories, tags, collections, brands };
		} catch (error) {
			logger.error(
				`[${directorySlug}] Error during category processing: ${this.formatError(error)}`,
				getErrorStack(error)
			);

			// Fallback: assign default category and no tags
			const defaultCategory = { id: 'others', name: 'Others' };
			const finalItems = extractedItems.map((item) => ({
				...item,
				tags: [],
				category: 'others',
				slug: item.slug || slugifyText(item.name)
			})) as MutableItemData[];

			return {
				finalItems,
				categories: [defaultCategory],
				tags: [],
				collections: [],
				brands: []
			};
		}
	}

	/**
	 * Categorize items using AI
	 */
	private async categorizeItems(
		prompt: string,
		items: MutableItemData[],
		existingCategories: Set<string>,
		existingTags: Set<string>,
		initialCategoryMetrics: Record<string, number>,
		metrics: StandardPipelineMetrics,
		customPrompt: string | null | undefined,
		execContext: StepExecutionContext
	): Promise<MutableItemData[]> {
		const { logger, aiFacade, promptFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		if (!items || items.length === 0) return [];

		try {
			// Process in batches if there are many items
			if (items.length > this.BATCH_SIZE) {
				return this.processBatchCategorization(
					prompt,
					items,
					existingCategories,
					existingTags,
					initialCategoryMetrics,
					metrics,
					customPrompt,
					execContext
				);
			}

			// Format existing categories and tags for the prompt
			const categoriesText = Array.from(existingCategories).join(', ');
			const tagsText = Array.from(existingTags).join(', ');

			// Use enhanced prompt if we have existing categories/tags
			const hasContext = existingCategories.size > 0 || existingTags.size > 0;

			// Resolve prompts from external provider, then apply custom prompt
			const resolvedEnhanced = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.ENHANCED_CATEGORY_PROCESSING, ENHANCED_CATEGORY_PROMPT)
					: ENHANCED_CATEGORY_PROMPT
			) as typeof ENHANCED_CATEGORY_PROMPT;
			const resolvedBase = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.CATEGORY_PROCESSING, CATEGORY_PROMPT)
					: CATEGORY_PROMPT
			) as typeof CATEGORY_PROMPT;
			const finalEnhancedPrompt = appendCustomPrompt(resolvedEnhanced, customPrompt);
			const finalBasePrompt = appendCustomPrompt(resolvedBase, customPrompt);

			const { result, usage, cost } = hasContext
				? await aiFacade.askJson<CategorizeResult>(
						finalEnhancedPrompt,
						categorizeOutputSchema,
						{
							temperature: 0.3,
							variables: {
								task: prompt,
								items: JSON.stringify(items),
								existing_categories: categoriesText,
								existing_tags: tagsText,
								category_metrics: JSON.stringify(initialCategoryMetrics)
							},
							routing: {
								complexity: 'medium',
								taskId: 'category-processing'
							}
						},
						facadeOptions
					)
				: await aiFacade.askJson<CategorizeResult>(
						finalBasePrompt,
						categorizeOutputSchema,
						{
							temperature: 0.3,
							variables: {
								task: prompt,
								items: JSON.stringify(items)
							},
							routing: {
								complexity: 'medium',
								taskId: 'category-processing'
							}
						},
						facadeOptions
					);

			this.accumulateMetrics(metrics, usage, cost);
			return (result?.items || []) as MutableItemData[];
		} catch (error) {
			logger.error(`Error during AI categorization: ${this.formatError(error)}`, getErrorStack(error));

			// Fallback to items with default category and tags
			return items.map((item) => ({
				...item,
				tags: [],
				category: 'others',
				slug: item.slug || slugifyText(item.name)
			})) as MutableItemData[];
		}
	}

	/**
	 * Process items in batches for categorization
	 */
	private async processBatchCategorization(
		prompt: string,
		items: MutableItemData[],
		existingCategories: Set<string>,
		existingTags: Set<string>,
		initialCategoryMetrics: Record<string, number>,
		metrics: StandardPipelineMetrics,
		customPrompt: string | null | undefined,
		execContext: StepExecutionContext
	): Promise<MutableItemData[]> {
		const { logger, aiFacade, promptFacade } = execContext;
		const allCategorizedItems: MutableItemData[] = [];

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		// Process items in batches
		for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
			const batch = items.slice(i, i + this.BATCH_SIZE);
			const batchNumber = Math.floor(i / this.BATCH_SIZE) + 1;
			const totalBatches = Math.ceil(items.length / this.BATCH_SIZE);

			logger.log(`Processing batch ${batchNumber} of ${totalBatches} (${batch.length} items)`);

			try {
				// Format existing categories and tags for the prompt
				const categoriesText = Array.from(existingCategories).join(', ');
				const tagsText = Array.from(existingTags).join(', ');

				// Format categories metrics for the prompt
				const total_items = initialCategoryMetrics.total_items || 0;
				const categoryMetrics: Record<string, number> = {
					...initialCategoryMetrics,
					categorized_items: total_items + allCategorizedItems.length,
					total_items: total_items + items.length
				};
				allCategorizedItems.forEach((item) => {
					const category = typeof item.category === 'string' ? item.category : '';
					if (!category) return;
					categoryMetrics[category] = (categoryMetrics[category] || 0) + 1;
				});

				// Always use enhanced prompt for batch processing (we always have context)
				const resolvedBatchPrompt = (
					promptFacade
						? await promptFacade.getPrompt(
								PROMPT_KEYS.ENHANCED_CATEGORY_PROCESSING,
								ENHANCED_CATEGORY_PROMPT
							)
						: ENHANCED_CATEGORY_PROMPT
				) as typeof ENHANCED_CATEGORY_PROMPT;
				const finalPrompt = appendCustomPrompt(resolvedBatchPrompt, customPrompt);
				const { result, usage, cost } = await aiFacade.askJson<CategorizeResult>(
					finalPrompt,
					categorizeOutputSchema,
					{
						temperature: 0.3,
						variables: {
							task: prompt,
							items: JSON.stringify(batch),
							category_metrics: JSON.stringify(categoryMetrics),
							existing_categories: categoriesText,
							existing_tags: tagsText
						},
						routing: {
							complexity: 'medium',
							taskId: 'category-processing-batch'
						}
					},
					facadeOptions
				);

				this.accumulateMetrics(metrics, usage, cost);
				const batchResults = (result?.items || []) as MutableItemData[];

				// Extract and store categories and tags from this batch for future batches
				batchResults.forEach((item) => {
					if (item.category && typeof item.category === 'string') {
						existingCategories.add(item.category);
					}

					if (Array.isArray(item.tags)) {
						item.tags.forEach((tag: string | { name: string }) => {
							if (typeof tag === 'string') {
								existingTags.add(tag);
							}
						});
					}
				});

				logger.debug(
					`Batch ${batchNumber} complete. Categories: ${existingCategories.size}, Tags: ${existingTags.size}`
				);

				allCategorizedItems.push(...batchResults);

				// Add a small delay between batches to avoid rate limiting
				if (i + this.BATCH_SIZE < items.length) {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			} catch (error) {
				logger.error(`Error during batch categorization: ${this.formatError(error)}`, getErrorStack(error));

				// Fallback for this batch - use existing categories if available
				const fallbackCategory = existingCategories.size > 0 ? Array.from(existingCategories)[0] : 'others';

				const fallbackItems = batch.map((item) => ({
					...item,
					category: fallbackCategory,
					tags: [],
					slug: item.slug || slugifyText(item.name)
				})) as MutableItemData[];

				allCategorizedItems.push(...fallbackItems);
			}
		}

		// Final consistency pass to normalize categories and tags
		return this.normalizeCategorizationResults(allCategorizedItems);
	}

	/**
	 * Normalize categorization results for consistency
	 */
	private normalizeCategorizationResults(items: MutableItemData[]): MutableItemData[] {
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
				.map(([category]) => category)
		);

		// If we filtered out all categories, keep at least one
		if (validCategories.size === 0 && categoryFrequency.size > 0) {
			// Find the most frequent category
			const mostFrequentCategory = Array.from(categoryFrequency.entries()).sort((a, b) => b[1] - a[1])[0][0];
			validCategories.add(mostFrequentCategory);
		}

		// Default category if needed
		const defaultCategory = validCategories.size > 0 ? Array.from(validCategories)[0] : 'others';

		// Normalize items
		return items.map((item) => {
			const category = typeof item.category === 'string' ? item.category : '';

			return {
				...item,
				// Use the category if it's valid, otherwise use the default
				category: validCategories.has(category) ? category : defaultCategory
			};
		});
	}

	/**
	 * Extract unique categories from categorized items
	 */
	private extractUniqueCategories(items: MutableItemData[], priorityCategories: string[] = []): Category[] {
		const categoryNames = items.reduce((acc, item) => {
			if (Array.isArray(item.category)) {
				acc.push(...item.category);
			} else if (typeof item.category === 'string') {
				acc.push(item.category);
			}

			return acc;
		}, [] as string[]);

		return this.mapUniqueWithPriority(categoryNames, priorityCategories);
	}

	/**
	 * Extract unique tags from categorized items
	 */
	private extractUniqueTags(items: MutableItemData[]): Tag[] {
		const tagNames = items.flatMap((item) => (item.tags as string[]) || []);
		return this.mapUnique(tagNames);
	}

	/**
	 * Extract unique collections from categorized items
	 */
	private extractUniqueCollections(items: MutableItemData[]): Collection[] {
		const collectionNames = items
			.map((item) => item.collection)
			.filter((c): c is string => typeof c === 'string' && c.length > 0);
		return this.mapUnique(collectionNames);
	}

	/**
	 * Extract unique brands from categorized items and merge with existing brands when possible
	 */
	private extractUniqueBrands(items: MutableItemData[], existingBrands: Brand[] = []): Brand[] {
		const existingByName = new Map(existingBrands.map((brand) => [brand.name.toLowerCase(), brand] as const));

		const brandCandidates: Brand[] = [];

		items.forEach((item) => {
			const brandName =
				typeof item.brand === 'string'
					? item.brand
					: typeof (item.brand as { name?: string })?.name === 'string'
						? (item.brand as { name: string }).name
						: null;

			if (!brandName) {
				return;
			}

			const normalized = brandName.trim();
			const existing = existingByName.get(normalized.toLowerCase());

			const brand_logo_url =
				item.brand && typeof item.brand === 'object'
					? (item.brand as { logo_url?: string }).logo_url
					: item.brand_logo_url || undefined;

			if (existing) {
				// Preserve existing id/logo when we already have the brand
				brandCandidates.push({
					...existing,
					logo_url: existing.logo_url || brand_logo_url || existing.logo_url
				});
				return;
			}

			brandCandidates.push({
				id: slugifyText(normalized),
				name: normalized,
				logo_url: brand_logo_url || undefined
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
	 */
	private mapUnique(names: string[]): Array<{ id: string; name: string }> {
		const unique = new Set(names.filter(Boolean));
		return Array.from(unique).map((name) => ({
			id: slugifyText(name),
			name
		}));
	}

	/**
	 * Map an array of names to unique identifiable objects with priority support
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
				priority
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
	 * Convert a partial item to a full MutableItemData object
	 */
	private toItemData(item: Partial<MutableItemData>): MutableItemData {
		const brandName =
			typeof item.brand === 'string'
				? item.brand
				: typeof (item.brand as { name?: string })?.name === 'string'
					? (item.brand as { name: string }).name
					: undefined;
		const brandSlug = brandName ? slugifyText(brandName) : undefined;
		const brandLogoUrl =
			(item.brand && typeof item.brand === 'object' && (item.brand as { logo_url?: string }).logo_url) ||
			item.brand_logo_url ||
			undefined;

		return {
			...(item as MutableItemData),
			category: slugifyText(item.category as string),
			tags: Array.isArray(item.tags)
				? item.tags.map((tag: string | { name: string }) =>
						slugifyText(typeof tag === 'string' ? tag : tag.name)
					)
				: [],
			collection: item.collection ? slugifyText(item.collection) : undefined,
			slug: item.slug || slugifyText(item.name || ''),
			brand: brandSlug,
			brand_logo_url: brandLogoUrl || null
		};
	}
}

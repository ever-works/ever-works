import { Injectable, Logger } from '@nestjs/common';
import { CreateItemsGeneratorDto, GenerationMethod } from './dto/create-items-generator.dto';
import {
    AiItemGenerationService,
    SearchQueryGenerationService,
    WebPageRetrievalService,
    ContentFilteringService,
    ItemExtractionService,
    SourceValidationService,
    DataAggregationService,
    CategoryProcessingService,
    MarkdownGenerationService,
    PromptProcessingService,
    PromptComparisonService,
    BadgeProcessingService,
} from './steps';
import { Category, ItemData, Tag } from './dto';
import { IDataConfig } from '../data-generator/data-repository';
import { WebPageData } from './interfaces/items-generator.interfaces';

@Injectable()
export class ItemsGeneratorService {
    private readonly logger = new Logger(ItemsGeneratorService.name);

    constructor(
        private readonly promptComparisonService: PromptComparisonService,
        private readonly promptProcessingService: PromptProcessingService,
        private readonly aiItemGenerationService: AiItemGenerationService,
        private readonly searchQueryGenerationService: SearchQueryGenerationService,
        private readonly webPageRetrievalService: WebPageRetrievalService,
        private readonly contentFilteringService: ContentFilteringService,
        private readonly itemExtractionService: ItemExtractionService,
        private readonly sourceValidationService: SourceValidationService,
        private readonly dataAggregationService: DataAggregationService,
        private readonly categoryProcessingService: CategoryProcessingService,
        private readonly markdownGenerationService: MarkdownGenerationService,
        private readonly badgeProcessingService: BadgeProcessingService,
    ) {}

    /**
     * Entry point for generating items.
     *
     * @param createItemsGeneratorDto
     * @param existing
     * @returns
     */
    async generateItemsGenerator(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        existing: {
            existingItems?: ItemData[];
            existingCategories?: Category[];
            existingTags?: Tag[];
            existingConfig?: IDataConfig;
        } = {},
    ) {
        const { slug, name, source_urls, config } = createItemsGeneratorDto;

        this.logger.log(`Starting generation for slug: ${slug}, name: ${name}`);

        try {
            let {
                existingItems = [],
                existingCategories = [],
                existingTags = [],
                existingConfig,
            } = existing;

            // reset existing if we are in recreate mode
            if (createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE) {
                existingItems = [];
                existingCategories = [];
                existingTags = [];
            }

            // Log the number of existing items, categories, and tags (if any)
            if (existingItems.length || existingCategories.length || existingTags.length) {
                this.logger.log(`Loaded ${existingItems.length} existing items for slug: ${slug}`);
                this.logger.log(
                    `Loaded ${existingCategories.length} existing categories for slug: ${slug}`,
                );
                this.logger.log(`Loaded ${existingTags.length} existing tags for slug: ${slug}`);
            }

            // 1.0. Prompt Comparison
            const configMetadata = existingConfig?.metadata || {};
            if (
                configMetadata?.initial_prompt &&
                createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE &&
                existingItems.length > 0
            ) {
                this.logger.log(`[${slug}] 1.0. Prompt Comparison - Starting`);
                const comparisonResult = await this.promptComparisonService.comparePrompts(
                    slug,
                    configMetadata.initial_prompt,
                    createItemsGeneratorDto.prompt,
                );

                const confidence = comparisonResult.confidence;
                const confidenceThreshold = config.prompt_comparison_confidence_threshold || 0.5;

                const areRelated =
                    comparisonResult.areRelated &&
                    comparisonResult.confidence > confidenceThreshold;

                this.logger.log(
                    `[${slug}] Prompt comparison: ${comparisonResult.areRelated ? 'RELATED' : 'UNRELATED'} ` +
                        `(confidence: ${confidence.toFixed(2)})`,
                );

                // If prompts are not related, throw an error
                // Preventing data inconsistency
                if (!areRelated) {
                    throw new Error(
                        `Prompt comparison failed. Prompts are not related. Confidence: ${confidence.toFixed(
                            2,
                        )}`,
                    );
                }
            }

            const processedSourceUrls = new Set<string>();

            // 1.1. Process Prompt (Extract URLs, Categories, Priorities, and Featured Item Hints)
            this.logger.log(
                `[${slug}] 1.1. Prompt Processing (URLs, Categories, Priorities, and Featured Hints) - Starting`,
            );
            const {
                extractedUrls,
                suggestedCategories,
                priorityCategories: promptPriorityCategories,
                featuredItemHints,
                rewrittenPrompt: prompt,
            } = await this.promptProcessingService.processPrompt(
                slug,
                createItemsGeneratorDto.prompt,
            );

            // Merge priority categories from DTO with those extracted from prompt
            const allPriorityCategories = [
                ...(createItemsGeneratorDto.priority_categories || []),
                ...promptPriorityCategories,
            ].filter((category, index, arr) => arr.indexOf(category) === index); // Remove duplicates

            // Merge initial categories from DTO with categories extracted from prompt
            // Priority categories must also be included in initial categories
            const allInitialCategories = [
                ...(createItemsGeneratorDto.initial_categories || []),
                ...suggestedCategories,
                ...allPriorityCategories, // Ensure priority categories are included in initial categories
            ].filter((category, index, arr) => arr.indexOf(category) === index); // Remove duplicates

            if (allInitialCategories.length > 0) {
                this.logger.log(
                    `[${slug}] Found ${allInitialCategories.length} initial categories: ${allInitialCategories.join(', ')}`,
                );
            }

            if (allPriorityCategories.length > 0) {
                this.logger.log(
                    `[${slug}] Found ${allPriorityCategories.length} priority categories: ${allPriorityCategories.join(', ')}`,
                );
            }

            if (featuredItemHints.length > 0) {
                this.logger.log(
                    `[${slug}] Found ${featuredItemHints.length} featured item hints: ${featuredItemHints.join(', ')}`,
                );
            }

            this.logger.log(`[${slug}] Rewritten prompt: "${prompt}"`);

            // Update the prompt in the DTO
            createItemsGeneratorDto.prompt = prompt;

            // Add source_urls to the extractedUrls
            extractedUrls.push(...(source_urls || []));

            // 1.5. AI-First Item Generation
            let initialAiItems: ItemData[] = [];

            if (config.ai_first_generation_enabled) {
                this.logger.log(`[${slug}] 1.5. AI-First Item Generation - Invoking`);
                initialAiItems = await this.aiItemGenerationService.generateInitialItemsWithAI(
                    createItemsGeneratorDto,
                    featuredItemHints,
                );
                this.logger.log(`[${slug}] AI generated ${initialAiItems.length} initial items.`);
            }

            // 2. AI-Powered Search Query Generation
            this.logger.log(`[${slug}] 2. AI-Powered Search Query Generation - Starting`);
            const searchQueries =
                await this.searchQueryGenerationService.generateSearchQueries(
                    createItemsGeneratorDto,
                );
            this.logger.log(`[${slug}] Generated ${searchQueries.length} search queries.`);

            // 3. Web Search & Content Retrieval
            this.logger.log(`[${slug}] 3. Web Search & Content Retrieval - Starting`);

            // Process extracted URLs first if any were found
            let initialWebPages: WebPageData[] = [];
            if (extractedUrls.length > 0) {
                initialWebPages = await this.webPageRetrievalService.retrieveSpecificUrls(
                    slug,
                    extractedUrls,
                    processedSourceUrls,
                );
                this.logger.log(
                    `[${slug}] Retrieved ${initialWebPages.length} web pages from extracted URLs`,
                );
            }

            // Then proceed with normal web search
            const searchWebPages = await this.webPageRetrievalService.retrieveWebPages(
                slug,
                searchQueries,
                processedSourceUrls,
                config,
            );

            // Combine web pages from both sources
            const webPages = [...initialWebPages, ...searchWebPages];
            this.logger.log(`[${slug}] Retrieved ${webPages.length} web pages for processing.`);

            // 4. Content Pre-filtering & Relevance Assessment
            this.logger.log(`[${slug}] 4. Content Pre-filtering & Relevance Assessment - Starting`);
            const relevantPages = await this.contentFilteringService.filterAndAssessPages(
                slug,
                webPages,
                name,
                prompt,
                config,
            );
            this.logger.log(`[${slug}] Filtered down to ${relevantPages.length} relevant pages.`);

            // 5. AI-Driven Structured Data Extraction for Items (from Web)
            this.logger.log(
                `[${slug}] 5. AI-Driven Structured Data Extraction for Items from Web - Starting`,
            );
            const extractedWebItems: ItemData[] =
                await this.itemExtractionService.extractItemsFromPages(
                    createItemsGeneratorDto,
                    relevantPages,
                    featuredItemHints,
                );
            this.logger.log(
                `[${slug}] Extracted ${extractedWebItems.length} potential items from web pages.`,
            );

            // Combine AI-generated items and web-extracted items
            const allDiscoveredItems = [...initialAiItems, ...extractedWebItems];
            this.logger.log(
                `[${slug}] Total discovered items (AI + Web before source validation): ${allDiscoveredItems.length}.`,
            );

            // 6. Deduplication and Data Aggregation
            this.logger.log(`[${slug}] 6. Deduplication and Data Aggregation - Starting`);
            const { aggregatedItems, metrics } =
                await this.dataAggregationService.aggregateAndDeduplicateData(
                    createItemsGeneratorDto,
                    existingItems,
                    allDiscoveredItems,
                    webPages.length,
                    relevantPages.length,
                );

            // 7. Category and Tag Generation
            this.logger.log(`[${slug}] 7. Category and Tag Generation - Starting`);

            // Create a modified DTO with merged priority categories
            const dtoWithMergedPriorities = {
                ...createItemsGeneratorDto,
                priority_categories: allPriorityCategories,
            };

            const { categories, tags, finalItems } =
                await this.categoryProcessingService.processCategoriesAndTags(
                    dtoWithMergedPriorities,
                    aggregatedItems,
                    existingCategories || [],
                    existingTags || [],
                    allInitialCategories,
                );

            this.logger.log(
                `[${slug}] Directory data generation complete. Final metrics: ${JSON.stringify(metrics)}`,
            );

            // 8. Filter and Validate Source URLs for all discovered items
            this.logger.log(`[${slug}] 8. Filter and Validate Source URLs - Starting`);
            let validatedItems = await this.sourceValidationService.filterAndValidateSourceItems(
                finalItems,
                slug,
            );

            // 9. Badge Processing for Repository Items
            if (createItemsGeneratorDto.badge_evaluation_enabled) {
                this.logger.log(`[${slug}] 9. Badge Processing for Repository Items - Starting`);
                validatedItems = await this.badgeProcessingService.processBadges(validatedItems);

                // Log badge statistics
                const badgeStats = this.badgeProcessingService.getBadgeStatistics(validatedItems);
                this.logger.log(
                    `[${slug}] Badge processing completed. Statistics: ${JSON.stringify(badgeStats)}`,
                );
            }

            // This is where a more robust notification (webhook, websocket, email) would be triggered,
            // potentially including the 'metrics'

            return {
                items: validatedItems,
                categories: categories,
                tags: tags,
            };
        } catch (error: any) {
            this.logger.error(
                `Error generating directory data for slug ${slug}: ${error.message}`,
                error.stack,
            );

            throw error;
        }
    }

    /**
     * Generate markdown for a single item
     * @param item The item to generate markdown for
     * @returns The item with markdown content
     */
    async generateMarkdownForItem(item: ItemData): Promise<ItemData> {
        this.logger.log(`Generating markdown for item: ${item.name}`);

        try {
            const markdown = await this.markdownGenerationService.generateMarkdown(item);

            return {
                ...item,
                markdown,
            };
        } catch (error) {
            this.logger.error(
                `Error generating markdown for item ${item.name}: ${error.message}`,
                error.stack,
            );

            return {
                ...item,
                markdown: '',
            };
        }
    }

    /**
     * Process badges for a single item
     * @param item The item to process badges for
     * @returns The item with badges
     */
    async processSingleItemBadges(item: ItemData): Promise<ItemData> {
        this.logger.log(`Processing badges for item: ${item.name}`);

        try {
            return await this.badgeProcessingService.processSingleItemBadges(item);
        } catch (error) {
            this.logger.error(
                `Error processing badges for item ${item.name}: ${error.message}`,
                error.stack,
            );

            return item;
        }
    }

    /**
     * Generate markdown for multiple items
     * @param items The items to generate markdown for
     * @returns The items with markdown content
     */
    async generateMarkdownForItems(items: ItemData[]): Promise<ItemData[]> {
        if (!items || items.length === 0) {
            return [];
        }

        try {
            return await this.markdownGenerationService.generateMarkdownForItems(items);
        } catch (error) {
            this.logger.error(`Error generating markdown for items: ${error.message}`, error.stack);

            // Return the original items without markdown
            return items.map((item) => ({
                ...item,
                markdown: '',
            }));
        }
    }

    /**
     * Extract item details from a single source URL
     * @param sourceUrl The URL to extract item details from
     * @param existingCategories Optional existing categories to consider
     * @returns The extracted item data
     */
    async extractItemDetailsFromUrl(
        sourceUrl: string,
        existingCategories: string[] = [],
    ): Promise<ItemData | null> {
        this.logger.log(`Extracting item details from URL: ${sourceUrl}`);

        try {
            // 1. Retrieve web page content
            const webPages = await this.webPageRetrievalService.retrieveSpecificUrls(
                'extract-item',
                [sourceUrl],
                new Set(),
            );

            if (!webPages || webPages.length === 0) {
                this.logger.warn(`Failed to retrieve content from URL: ${sourceUrl}`);
                return null;
            }

            const webPage = webPages[0];
            if (!webPage.raw_content || webPage.raw_content.trim().length === 0) {
                this.logger.warn(`No content found for URL: ${sourceUrl}`);
                return null;
            }

            // 2. Create a minimal DTO for extraction
            const extractionDto = {
                slug: 'extract-item',
                name: 'Item Extraction',
                prompt: `Extract details for a single item from the provided content. ${
                    existingCategories.length > 0
                        ? `Consider these existing categories when categorizing: ${existingCategories.join(', ')}`
                        : ''
                }`,
                initial_categories: existingCategories,
            };

            // 3. Extract item details using the existing extraction service
            const extractedItems = await this.itemExtractionService.extractItemsFromPages(
                {
                    ...extractionDto,
                    config: {
                        max_search_queries: 1,
                        max_results_per_query: 1,
                        max_pages_to_process: 1,
                        relevance_threshold_content: 0.5,
                        min_content_length_for_extraction: 100,
                        ai_first_generation_enabled: false,
                        prompt_comparison_confidence_threshold: 0.5,
                    },
                },
                [webPage],
                [], // No featured hints for single item extraction
            );

            if (!extractedItems || extractedItems.length === 0) {
                this.logger.warn(`No items extracted from URL: ${sourceUrl}`);
                return null;
            }

            // 4. Take the first extracted item and enhance it
            let item = extractedItems[0];

            // Ensure the source URL matches the input
            item.source_url = sourceUrl;

            // Ensure featured is always false for extracted items
            item.featured = false;

            // 5. Generate markdown for the item
            item = await this.generateMarkdownForItem(item);

            // 6. Process badges for the item
            item = await this.processSingleItemBadges(item);

            this.logger.log(`Successfully extracted item: ${item.name} from ${sourceUrl}`);
            return item;
        } catch (error) {
            this.logger.error(`Error extracting item details from ${sourceUrl}:`, error);
            return null;
        }
    }
}

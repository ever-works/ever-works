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
    DomainDetectionService,
} from './steps';
import { Category, ItemData, Tag } from './dto';
import { IDataConfig } from '../data-generator/data-repository';
import { WebPageData } from './interfaces/items-generator.interfaces';
import { Directory } from '../entities';
import { ItemsGeneratorStep } from './constants/steps';
import { AiService } from '../ai';

export type ExistingItems = {
    existingItems?: ItemData[];
    existingCategories?: Category[];
    existingTags?: Tag[];
    existingConfig?: IDataConfig;
};

@Injectable()
export class ItemsGeneratorService {
    private readonly logger = new Logger(ItemsGeneratorService.name);

    constructor(
        private readonly aiService: AiService,
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
        private readonly domainDetectionService: DomainDetectionService,
    ) {}

    /**
     * Entry point for generating items.
     *
     * @param createItemsGeneratorDto
     * @param existing
     * @returns
     */
    async generateItems(
        directory: Directory,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        existing: ExistingItems = {},
        onProgress?: (step: string) => void,
    ) {
        // Make a copy of the DTO to avoid mutating the original
        createItemsGeneratorDto = { ...createItemsGeneratorDto };

        const directorySlug = directory.slug;

        const { name, source_urls, config, prompt: originalPrompt } = createItemsGeneratorDto;

        this.logger.log(`Starting generation for directory: ${directorySlug}, name: ${name}`);

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
                this.logger.log(
                    `Loaded ${existingItems.length} existing items for directory: ${directorySlug}`,
                );
                this.logger.log(
                    `Loaded ${existingCategories.length} existing categories for directory: ${directorySlug}`,
                );
                this.logger.log(
                    `Loaded ${existingTags.length} existing tags for directory: ${directorySlug}`,
                );
            }

            // Test AI configuration
            const aiTestResult = await this.aiService.testDefaultProvider();
            if (!aiTestResult.success) {
                throw new Error(`${aiTestResult.provider} Test failed: ${aiTestResult.error}`);
            }

            // 1.0. Prompt Comparison
            const $configMetadata = existingConfig?.metadata || {};
            if (
                $configMetadata?.initial_prompt &&
                createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE &&
                existingItems.length > 0
            ) {
                onProgress?.(ItemsGeneratorStep.PROMPT_COMPARISON);
                this.logger.log(`[${directorySlug}] 1.0. Prompt Comparison - Starting`);

                const comparisonResult = await this.promptComparisonService.comparePrompts(
                    directorySlug,
                    $configMetadata.initial_prompt,
                    createItemsGeneratorDto.prompt,
                );

                const confidence = comparisonResult.confidence;
                const confidenceThreshold = config.prompt_comparison_confidence_threshold || 0.5;

                const areRelated =
                    comparisonResult.areRelated &&
                    comparisonResult.confidence > confidenceThreshold;

                this.logger.log(
                    `[${directorySlug}] Prompt comparison: ${comparisonResult.areRelated ? 'RELATED' : 'UNRELATED'} ` +
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

            // 1.1. Process Prompt (Extract URLs, Categories, Priorities, and Featured Item Hints)
            onProgress?.(ItemsGeneratorStep.PROMPT_PROCESSING);
            this.logger.log(
                `[${directorySlug}] 1.1. Prompt Processing (URLs, Categories, Priorities, and Featured Hints) - Starting`,
            );

            const {
                extractedUrls: extractedUrlsFromPrompt,
                suggestedCategories,
                priorityCategories: promptPriorityCategories,
                featuredItemHints,
                rewrittenPrompt: prompt,
            } = await this.promptProcessingService.processPrompt(
                directorySlug,
                createItemsGeneratorDto.prompt,
            );

            // Merge priority categories from DTO with those extracted from prompt
            const allPriorityCategories = [
                ...(createItemsGeneratorDto.priority_categories || []),
                ...promptPriorityCategories,
            ].filter((category, index, arr) => arr.indexOf(category) === index);

            // Merge initial categories from DTO with categories extracted from prompt
            // Priority categories must also be included in initial categories
            const allInitialCategories = [
                ...(createItemsGeneratorDto.initial_categories || []),
                ...suggestedCategories,
                ...allPriorityCategories, // Ensure priority categories are included in initial categories
            ].filter((category, index, arr) => arr.indexOf(category) === index);

            if (allInitialCategories.length > 0) {
                this.logger.log(
                    `[${directorySlug}] Found ${allInitialCategories.length} initial categories: ${allInitialCategories.join(', ')}`,
                );
            }

            if (allPriorityCategories.length > 0) {
                this.logger.log(
                    `[${directorySlug}] Found ${allPriorityCategories.length} priority categories: ${allPriorityCategories.join(', ')}`,
                );
            }

            if (featuredItemHints.length > 0) {
                this.logger.log(
                    `[${directorySlug}] Found ${featuredItemHints.length} featured item hints: ${featuredItemHints.join(', ')}`,
                );
            }

            this.logger.log(`[${directorySlug}] Rewritten prompt: "${prompt}"`);

            // Update the prompt in the DTO
            createItemsGeneratorDto.prompt = prompt;

            // Domain detection to adapt downstream steps
            const domainAnalysis = await this.domainDetectionService.detectDomain(
                directorySlug,
                prompt,
                name,
            );
            this.logger.log(
                `[${directorySlug}] Domain analysis → ${domainAnalysis.domain_type} (confidence ${domainAnalysis.confidence.toFixed(2)})`,
            );

            // Add source_urls to the extractedUrls
            let extractedUrls = extractedUrlsFromPrompt;
            extractedUrls.push(...(source_urls || []));

            // Remove urls from extractedUrls or source_urls that was processed in previous runs
            if (
                createItemsGeneratorDto.generation_method === GenerationMethod.CREATE_UPDATE &&
                ($configMetadata.last_request_data?.prompt ||
                    $configMetadata.last_request_data?.source_urls.length)
            ) {
                const last_request_data = $configMetadata.last_request_data;
                extractedUrls = extractedUrls.filter((url) => {
                    const $source_urls = last_request_data.source_urls || [];
                    const $prompt = last_request_data.prompt || '';
                    return !$source_urls.includes(url) && !$prompt.includes(url);
                });
            }

            // 1.5. AI-First Item Generation
            let initialAiItems: ItemData[] = [];

            if (config.ai_first_generation_enabled) {
                onProgress?.(ItemsGeneratorStep.AI_FIRST_ITEMS_GENERATION);
                this.logger.log(`[${directorySlug}] 1.5. AI-First Item Generation - Invoking`);

                initialAiItems = await this.aiItemGenerationService.generateInitialItemsWithAI(
                    directorySlug,
                    createItemsGeneratorDto,
                    featuredItemHints,
                );
                this.logger.log(
                    `[${directorySlug}] AI generated ${initialAiItems.length} initial items.`,
                );
            }

            // 2. AI-Powered Search Query Generation
            onProgress?.(ItemsGeneratorStep.SEARCH_QUERIES_GENERATION);
            this.logger.log(`[${directorySlug}] 2. AI-Powered Search Query Generation - Starting`);

            const searchQueries =
                await this.searchQueryGenerationService.generateSearchQueries(
                    createItemsGeneratorDto,
                );
            this.logger.log(`[${directorySlug}] Generated ${searchQueries.length} search queries.`);

            // 3. Web Search & Content Retrieval
            onProgress?.(ItemsGeneratorStep.WEB_SEARCH);
            this.logger.log(`[${directorySlug}] 3. Web Search & Content Retrieval - Starting`);

            const processedSourceUrls = new Set<string>();

            // Process extracted URLs first if any were found
            let initialWebPages: WebPageData[] = [];
            if (extractedUrls.length > 0) {
                initialWebPages = await this.webPageRetrievalService.retrieveSpecificUrls(
                    directorySlug,
                    extractedUrls,
                    processedSourceUrls,
                );
                this.logger.log(
                    `[${directorySlug}] Retrieved ${initialWebPages.length} web pages from extracted URLs`,
                );
            }

            // Then proceed with normal web search
            onProgress?.(ItemsGeneratorStep.CONTENT_RETRIEVAL);
            const searchWebPages = await this.webPageRetrievalService.retrieveWebPages(
                directorySlug,
                searchQueries,
                processedSourceUrls,
                config,
            );

            // Combine web pages from both sources
            let webPages = [...initialWebPages, ...searchWebPages];
            const urlsScannedThisRun = webPages.length;

            this.logger.log(
                `[${directorySlug}] Retrieved ${webPages.length} web pages for processing.`,
            );

            if (config.content_filtering_enabled) {
                // 4. Content Pre-filtering & Relevance Assessment
                onProgress?.(ItemsGeneratorStep.CONTENT_FILTERING);
                webPages = await this.contentFilteringService.filterAndAssessPages(
                    directorySlug,
                    webPages,
                    name,
                    prompt,
                    config,
                );

                this.logger.log(
                    `[${directorySlug}] Filtered down to ${webPages.length} relevant pages.`,
                );
            }

            // 5. AI-Driven Structured Data Extraction for Items (from Web)
            onProgress?.(ItemsGeneratorStep.ITEMS_EXTRACTION);
            this.logger.log(
                `[${directorySlug}] 5. AI-Driven Structured Data Extraction for Items from Web - Starting`,
            );

            const extractedWebItems: ItemData[] =
                await this.itemExtractionService.extractItemsFromPages(
                    directorySlug,
                    createItemsGeneratorDto,
                    webPages,
                    featuredItemHints,
                );
            this.logger.log(
                `[${directorySlug}] Extracted ${extractedWebItems.length} potential items from web pages.`,
            );

            // Combine AI-generated items and web-extracted items
            const allDiscoveredItems = [...initialAiItems, ...extractedWebItems];
            this.logger.log(
                `[${directorySlug}] Total discovered items (AI + Web before source validation): ${allDiscoveredItems.length}.`,
            );

            // 6. Deduplication and Data Aggregation
            onProgress?.(ItemsGeneratorStep.DEDUPLICATION_AND_DATA_AGGREGATION);
            this.logger.log(`[${directorySlug}] 6. Deduplication and Data Aggregation - Starting`);

            const { aggregatedItems, metrics } =
                await this.dataAggregationService.aggregateAndDeduplicateData({
                    directorySlug,
                    createItemsGeneratorDto,
                    existingItems,
                    urlsScannedThisRun,
                    newlyExtractedItemsThisRun: allDiscoveredItems,
                    pagesProcessedThisRun: webPages.length,
                });

            // 7. Category and Tag Generation
            onProgress?.(ItemsGeneratorStep.CATEGORIES_TAGS_PROCESSING);
            this.logger.log(`[${directorySlug}] 7. Category and Tag Generation - Starting`);

            // Create a modified DTO with merged priority categories
            const dtoWithMergedPriorities = {
                ...createItemsGeneratorDto,
                priority_categories: allPriorityCategories,
                prompt: originalPrompt,
            };

            const { categories, tags, finalItems } =
                await this.categoryProcessingService.processCategoriesAndTags({
                    directorySlug,
                    createItemsGeneratorDto: dtoWithMergedPriorities,
                    extractedItems: aggregatedItems,
                    existingCategories: existingCategories || [],
                    existingTags: existingTags || [],
                    initialCategories: allInitialCategories,
                    existingItems,
                });

            this.logger.log(
                `[${directorySlug}] Directory data generation complete. Final metrics: ${JSON.stringify(metrics)}`,
            );

            // 8. Filter and Validate Source URLs for all discovered items
            onProgress?.(ItemsGeneratorStep.SOURCES_VALIDATION);
            this.logger.log(`[${directorySlug}] 8. Filter and Validate Source URLs - Starting`);

            let validatedItems = await this.sourceValidationService.filterAndValidateSourceItems(
                directorySlug,
                finalItems,
            );

            // 9. Badge Processing for Repository Items
            if (createItemsGeneratorDto.badge_evaluation_enabled) {
                onProgress?.(ItemsGeneratorStep.BADGES_PROCESSING);
                this.logger.log(
                    `[${directorySlug}] 9. Badge Processing for Repository Items - Starting`,
                );

                validatedItems = await this.badgeProcessingService.processBadges(validatedItems);

                // Log badge statistics
                const badgeStats = this.badgeProcessingService.getBadgeStatistics(validatedItems);
                this.logger.log(
                    `[${directorySlug}] Badge processing completed. Statistics: ${JSON.stringify(badgeStats)}`,
                );
            }

            const finalMetrics = {
                ...metrics,
                total_items_in_store: validatedItems.length,
            };

            return {
                items: validatedItems,
                categories: categories,
                tags: tags,
                metrics: finalMetrics,
            };
        } catch (error: any) {
            this.logger.error(
                `Error generating directory data for directory ${directorySlug}: ${error.message}`,
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
                'extract-items-from-url',
                {
                    ...extractionDto,
                    config: {
                        max_search_queries: 1,
                        max_results_per_query: 1,
                        max_pages_to_process: 1,
                        relevance_threshold_content: 0.5,
                        min_content_length_for_extraction: 100,
                        ai_first_generation_enabled: false,
                        content_filtering_enabled: false,
                        prompt_comparison_confidence_threshold: 0.5,
                    },
                },
                [webPage],
                [], // No featured hints for single item extraction
                true, // we want to include category and tags
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

            // We don't need to generate it at this stage;
            // we can do so, for example, during submitItem.
            // // 5. Generate markdown for the item
            // item = await this.generateMarkdownForItem(item);
            // // 6. Process badges for the item
            // item = await this.processSingleItemBadges(item);

            this.logger.log(`Successfully extracted item: ${item.name} from ${sourceUrl}`);
            return item;
        } catch (error) {
            this.logger.error(`Error extracting item details from ${sourceUrl}:`, error);
            return null;
        }
    }
}

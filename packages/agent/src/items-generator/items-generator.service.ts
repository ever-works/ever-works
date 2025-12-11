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
import { Category, ItemData, Tag, Brand } from './dto';
import { IDataConfig } from '../data-generator/data-repository';
import { Directory } from '../entities';
import { AiService } from '../ai';
import { PipelineExecutor } from './pipeline/pipeline-executor';
import { GenerationContext } from './interfaces/pipeline.interface';
import { ParallelStep } from './pipeline/steps/parallel.step';

export type ExistingItems = {
    existingItems?: ItemData[];
    existingCategories?: Category[];
    existingTags?: Tag[];
    existingBrands?: Brand[];
    existingConfig?: IDataConfig;
};

@Injectable()
export class ItemsGeneratorService {
    private readonly logger = new Logger(ItemsGeneratorService.name);

    constructor(
        private readonly aiService: AiService,
        private readonly pipelineExecutor: PipelineExecutor,
        private readonly promptComparisonService: PromptComparisonService,
        private readonly promptProcessingService: PromptProcessingService,
        private readonly domainDetectionService: DomainDetectionService,
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
    ) {
        // Configure the pipeline once at startup
        this.pipelineExecutor
            .addStep(this.promptComparisonService)
            .addStep(this.promptProcessingService)
            .addStep(this.domainDetectionService)
            // Run AI Item Generation and Search Query Generation in parallel
            .addStep(
                new ParallelStep([this.aiItemGenerationService, this.searchQueryGenerationService]),
            )
            .addStep(this.webPageRetrievalService)
            .addStep(this.contentFilteringService)
            .addStep(this.itemExtractionService)
            .addStep(this.dataAggregationService)
            .addStep(this.categoryProcessingService)
            .addStep(this.sourceValidationService)
            .addStep(this.badgeProcessingService)
            .addStep(this.markdownGenerationService);
    }

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
        const { name } = createItemsGeneratorDto;

        this.logger.log(`Starting generation for directory: ${directorySlug}, name: ${name}`);

        try {
            // Handle existing data reset for RECREATE
            if (createItemsGeneratorDto.generation_method === GenerationMethod.RECREATE) {
                existing.existingItems = [];
                existing.existingCategories = [];
                existing.existingTags = [];
                existing.existingBrands = [];
            }

            // Test AI configuration
            const aiTestResult = await this.aiService.testDefaultProvider();
            if (!aiTestResult.success) {
                throw new Error(`${aiTestResult.provider} Test failed: ${aiTestResult.error}`);
            }

            let context: GenerationContext;
            let resumeFromStepName: string | undefined;

            // Attempt to load checkpoint
            const checkpoint = await this.pipelineExecutor.loadCheckpoint(directory);
            const lastStep = this.pipelineExecutor.getStepNames().length - 1;

            // Validate checkpoint has required data before using it
            const isValidCheckpoint =
                checkpoint &&
                checkpoint.context &&
                checkpoint.stepName &&
                checkpoint.stepIndex < lastStep;

            if (isValidCheckpoint) {
                this.logger.log(
                    `Found checkpoint for ${directorySlug}. Last completed step: ${checkpoint.stepName}`,
                );
                resumeFromStepName = checkpoint.stepName;

                // Reconstruct GenerationContext from checkpoint data
                context = {
                    ...checkpoint.context,
                    directory, // Restore directory entity (not serialized)
                    processedSourceUrls: new Set<string>(checkpoint.context.processedSourceUrls),
                    // Rebuild contentCache from webPages (Maps aren't serializable)
                    contentCache: new Map<string, string>(
                        (checkpoint.context.webPages || []).map((wp) => [
                            wp.source_url,
                            wp.raw_content,
                        ]),
                    ),
                };
                context.finalBrands = checkpoint.context.finalBrands || [];
            } else {
                if (checkpoint) {
                    this.logger.warn(
                        `Invalid checkpoint data for ${directorySlug}, starting fresh. Checkpoint: ${JSON.stringify(checkpoint).slice(0, 200)}`,
                    );
                }
                // Initialize new Context if no checkpoint found
                context = {
                    directory,
                    dto: createItemsGeneratorDto,
                    existing,
                    extractedUrls: [],
                    searchQueries: [],
                    webPages: [],
                    processedSourceUrls: new Set<string>(),
                    contentCache: new Map<string, string>(),
                    initialAiItems: [],
                    extractedWebItems: [],
                    aggregatedItems: [],
                    finalItems: [],
                    finalCategories: [],
                    finalTags: [],
                    finalBrands: [],
                    metrics: {
                        urls_scanned: 0,
                        pages_processed: 0,
                        items_extracted_current_run: 0,
                        new_items_added_to_store: 0,
                        total_items_in_store: 0,
                    },
                    allInitialCategories: [],
                    allPriorityCategories: [],
                    featuredItemHints: [],
                };
            }

            // Execute Pipeline
            const finalContext = await this.pipelineExecutor.execute(
                context,
                onProgress,
                resumeFromStepName,
            );

            return {
                items: finalContext.finalItems,
                categories: finalContext.finalCategories,
                tags: finalContext.finalTags,
                brands: finalContext.finalBrands,
                metrics: finalContext.metrics,
                contentCache: finalContext.contentCache,
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
     * @param contentCache Optional cache of source_url -> raw_content to avoid refetching
     * @returns The items with markdown content
     */
    async generateMarkdownForItems(
        items: ItemData[],
        contentCache?: Map<string, string>,
    ): Promise<ItemData[]> {
        if (!items || items.length === 0) {
            return [];
        }

        try {
            return await this.markdownGenerationService.generateMarkdownForItems(
                items,
                contentCache,
            );
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
                        relevance_threshold_content: 0.6,
                        min_content_length_for_extraction: 100,
                        ai_first_generation_enabled: false,
                        content_filtering_enabled: true,
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

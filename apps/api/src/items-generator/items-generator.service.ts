import { Injectable, Logger } from '@nestjs/common';
import {
  CreateItemsGeneratorDto,
  ConfigDto,
} from './dto/create-items-generator.dto';
import { AiItemGenerationService } from './steps/ai-item-generation.service';
import { SearchQueryGenerationService } from './steps/search-query-generation.service';
import { WebPageRetrievalService } from './steps/web-page-retrieval.service';
import { ContentFilteringService } from './steps/content-filtering.service';
import { ItemExtractionService } from './steps/item-extraction.service';
import { SourceValidationService } from './steps/source-validation.service';
import { DataAggregationService } from './steps/data-aggregation.service';
import { CategoryProcessingService } from './steps/category-processing.service';
import { MarkdownGenerationService } from './steps/markdown-generation.service';
import { Category, ItemData, Tag } from './dto';

// Default configuration values
const DEFAULT_CONFIG: Required<ConfigDto> = {
  max_search_queries: 10,
  max_results_per_query: 20,
  max_pages_to_process: 100,
  relevance_threshold_content: 0.75,
  min_content_length_for_extraction: 500,
};

@Injectable()
export class ItemsGeneratorService {
  private readonly logger = new Logger(ItemsGeneratorService.name);

  constructor(
    private readonly aiItemGenerationService: AiItemGenerationService,
    private readonly searchQueryGenerationService: SearchQueryGenerationService,
    private readonly webPageRetrievalService: WebPageRetrievalService,
    private readonly contentFilteringService: ContentFilteringService,
    private readonly itemExtractionService: ItemExtractionService,
    private readonly sourceValidationService: SourceValidationService,
    private readonly dataAggregationService: DataAggregationService,
    private readonly categoryProcessingService: CategoryProcessingService,
    private readonly markdownGenerationService: MarkdownGenerationService,
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
    } = {},
  ) {
    const { slug, name, description, target_keywords } =
      createItemsGeneratorDto;
    const config = { ...DEFAULT_CONFIG, ...createItemsGeneratorDto.config };

    this.logger.log(`Starting generation for slug: ${slug}, name: ${name}`);

    try {
      const {
        existingItems = [],
        existingCategories = [],
        existingTags = [],
      } = existing;

      const processedSourceUrls = new Set<string>();

      if (existingItems.length) {
        this.logger.log(
          `Loaded ${existingItems.length} existing items for slug: ${slug}`,
        );
      }

      if (existingCategories.length) {
        this.logger.log(
          `Loaded ${existingCategories.length} existing categories for slug: ${slug}`,
        );
      }
      if (existingTags.length) {
        this.logger.log(
          `Loaded ${existingTags.length} existing tags for slug: ${slug}`,
        );
      }
      this.logger.log(`[${slug}] 1. Initialization & Slug Handling - Complete`);

      // 1.5. AI-First Item Generation
      this.logger.log(`[${slug}] 1.5. AI-First Item Generation - Invoking`);
      const initialAiItems: ItemData[] =
        await this.aiItemGenerationService.generateInitialItemsWithAI(
          slug,
          name,
          description,
          target_keywords,
        );
      this.logger.log(
        `[${slug}] AI generated ${initialAiItems.length} initial items.`,
      );

      // 2. AI-Powered Search Query Generation
      this.logger.log(
        `[${slug}] 2. AI-Powered Search Query Generation - Starting`,
      );
      const searchQueries =
        await this.searchQueryGenerationService.generateSearchQueries(
          name,
          description,
          target_keywords,
          config,
        );
      this.logger.log(
        `[${slug}] Generated ${searchQueries.length} search queries.`,
      );

      // 3. Web Search & Content Retrieval
      this.logger.log(`[${slug}] 3. Web Search & Content Retrieval - Starting`);
      const webPages = await this.webPageRetrievalService.retrieveWebPages(
        slug,
        searchQueries,
        processedSourceUrls,
        config,
      );
      this.logger.log(
        `[${slug}] Retrieved ${webPages.length} web pages for processing.`,
      );

      // 4. Content Pre-filtering & Relevance Assessment
      this.logger.log(
        `[${slug}] 4. Content Pre-filtering & Relevance Assessment - Starting`,
      );
      const relevantPages =
        await this.contentFilteringService.filterAndAssessPages(
          slug,
          webPages,
          name,
          description,
          config,
        );
      this.logger.log(
        `[${slug}] Filtered down to ${relevantPages.length} relevant pages.`,
      );

      // 5. AI-Driven Structured Data Extraction for Items (from Web)
      this.logger.log(
        `[${slug}] 5. AI-Driven Structured Data Extraction for Items from Web - Starting`,
      );
      const extractedWebItems: ItemData[] =
        await this.itemExtractionService.extractItemsFromPages(
          slug,
          relevantPages,
          name,
          description,
          config,
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
      this.logger.log(
        `[${slug}] 6. Deduplication and Data Aggregation - Starting`,
      );
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
      const { categories, tags, finalItems } =
        await this.categoryProcessingService.processCategoriesAndTags(
          createItemsGeneratorDto,
          aggregatedItems,
        );

      this.logger.log(
        `[${slug}] Directory Builder generation complete. Final metrics: ${JSON.stringify(metrics)}`,
      );

      // 8. Filter and Validate Source URLs for all discovered items
      this.logger.log(
        `[${slug}] 8. Filter and Validate Source URLs - Starting`,
      );
      const validatedItems =
        await this.sourceValidationService.filterAndValidateSourceItems(
          finalItems,
          slug,
        );

      // This is where a more robust notification (webhook, websocket, email) would be triggered,
      // potentially including the 'metrics'

      return {
        items: validatedItems,
        categories: categories,
        tags: tags,
      };
    } catch (error: any) {
      this.logger.error(
        `Error generating directory builder for slug ${slug}: ${error.message}`,
        error.stack,
      );
      // Update a status file or send a notification about the error
    }

    return null;
  }

  /**
   * Generate markdown for a single item
   * @param item The item to generate markdown for
   * @returns The item with markdown content
   */
  async generateMarkdownForItem(item: ItemData): Promise<ItemData> {
    this.logger.log(`Generating markdown for item: ${item.name}`);

    try {
      const markdown =
        await this.markdownGenerationService.generateMarkdown(item);

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
   * Generate markdown for multiple items
   * @param items The items to generate markdown for
   * @returns The items with markdown content
   */
  async generateMarkdownForItems(items: ItemData[]): Promise<ItemData[]> {
    if (!items || items.length === 0) {
      return [];
    }

    this.logger.log(`Generating markdown for ${items.length} items`);

    try {
      return await this.markdownGenerationService.generateMarkdownForItems(
        items,
      );
    } catch (error) {
      this.logger.error(
        `Error generating markdown for items: ${error.message}`,
        error.stack,
      );

      // Return the original items without markdown
      return items.map((item) => ({
        ...item,
        markdown: '',
      }));
    }
  }
}

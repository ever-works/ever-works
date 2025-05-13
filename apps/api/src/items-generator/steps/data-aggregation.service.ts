import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { ItemsGeneratorMetrics } from '../dto/items-generator-response.dto';
import { AiService } from '../shared';
import { slugifyText } from '../utils/text.utils';
import { extractedItemsSchema } from '../schemas/item-extraction.schemas';
import { ItemData } from '../dto';

// Prompts for deduplication and extraction
const DEDUPLICATOR_PROMPT = `
You are directory website builder and your task is to deduplicate items.
Our crawlers found some items, but some of them MIGHT be duplicated.
Every item has name, description, and optionally URL of item's official website/repository.

<rules>
- Deduplicate the items based on names and URLs.
- Some products have slightly different names but are the same - consider them as duplicates.
- Transform any names that contains version numbers to the base name.
</rules>

Example of same items but with different names - they should be considered as duplicates:
<examples>
"React" and "React.js"
"Pandas 2.5" and "Pandas"
"express" and "Express"
"Docker" and "Docker Desktop"
"X by Y" and "X" (btw we prefer shorter names)
</examples>

Here is the list of items to deduplicate:
<items>
{items}
</items>
`.trim();

const EXTRACT_NEW_ITEMS_PROMPT = `
You are directory website builder and your task is to extract new items from the list.
We don't want to show duplicates to our users, so return only new items that don't exist in existing items list.

<rules>
- Deduplicate the items based on names and URLs - compare each new item with list of existing items.
- Some products have slightly different names but are the same - consider them as duplicates.
</rules>

Example of same items but with different names - they should be considered as duplicates:
<examples>
"React" and "React.js"
"Pandas 2.5" and "Pandas"
"express" and "Express"
"Docker" and "Docker Desktop"
"X by Y" and "X" (btw we prefer shorter names)
</examples>

Here is the list of existing items:
<existing>
{existing}
</existing>

Here is the list of new items:
<new>
{new}
</new>
`.trim();

@Injectable()
export class DataAggregationService {
  private readonly logger = new Logger(DataAggregationService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.createLlmWithTemperature(0.0); // Use temperature 0 for deterministic results
  }

  /**
   * Aggregates and deduplicates data from multiple sources
   */
  async aggregateAndDeduplicateData(
    createItemsGeneratorDto: CreateItemsGeneratorDto,
    existingItems: ItemData[],
    newlyExtractedItemsThisRun: ItemData[],
    urlsScannedThisRun: number,
    pagesProcessedThisRun: number,
  ) {
    const { slug, description } = createItemsGeneratorDto;
    this.logger.log(`[${slug}] Starting data aggregation and deduplication.`);

    // Track metrics
    let newItemsAddedToStoreCount = 0;

    // Deduplicate by fields first (faster than AI)
    this.logger.log(`[${slug}] Deduplicating items by fields`);
    let deduplicated = this.deduplicateByField(
      this.deduplicateByField(newlyExtractedItemsThisRun, 'slug'),
      'source_url',
    );

    this.logger.log(
      `[${slug}] Field-based deduplication: ${newlyExtractedItemsThisRun.length} → ${deduplicated.length} items`,
    );

    // Deduplicate with AI (more sophisticated)
    if (deduplicated.length > 0) {
      this.logger.log(`[${slug}] Deduplicating items with AI.`);
      deduplicated = await this.deduplicateWithAI(description, deduplicated);
      this.logger.log(
        `[${slug}] AI-based deduplication: ${deduplicated.length} items remaining`,
      );
    }

    // Extract new items (if we have existing items)
    let aggregatedItems = deduplicated;
    if (existingItems.length > 0 && deduplicated.length > 0) {
      this.logger.log(`[${slug}] Extracting new items.`);

      const previousCount = aggregatedItems.length;
      aggregatedItems = await this.extractNewItems(existingItems, deduplicated);
      newItemsAddedToStoreCount = aggregatedItems.length;

      this.logger.log(
        `[${slug}] New items extraction: ${previousCount} → ${aggregatedItems.length} items`,
      );
    }

    // Calculate metrics
    const metrics: ItemsGeneratorMetrics = {
      urls_scanned: urlsScannedThisRun,
      pages_processed: pagesProcessedThisRun,
      items_extracted_current_run: newlyExtractedItemsThisRun.length,
      new_items_added_to_store: newItemsAddedToStoreCount,
      total_items_in_store: aggregatedItems.length,
    };

    this.logger.log(
      `[${slug}] Data aggregation and deduplication complete. Final item count: ${aggregatedItems.length}`,
    );

    return { aggregatedItems, metrics };
  }

  /**
   * Deduplicates items by a specific field
   * @param items Array of items to deduplicate
   * @param field Field to deduplicate by
   * @returns Deduplicated array
   */
  private deduplicateByField<T extends Record<string, any>>(
    items: T[],
    field: keyof T,
  ): T[] {
    if (!items || items.length === 0) return [];

    // Skip deduplication if the field doesn't exist in the items
    if (
      !items.some((item) => item[field] !== undefined && item[field] !== null)
    ) {
      return items;
    }

    const map = new Map<string, T>();
    for (const item of items) {
      const value = item[field];
      if (value !== undefined && value !== null && typeof value === 'string') {
        map.set(value, item);
      } else {
        // If the field is missing or not a string, use a unique identifier
        map.set(`__no_${String(field)}_${Math.random()}`, item);
      }
    }
    return Array.from(map.values());
  }

  /**
   * Deduplicates items using AI with chunking for large arrays
   * @param description Description of the directory
   * @param items Items to deduplicate
   * @returns Deduplicated items
   */
  private async deduplicateWithAI(
    description: string,
    items: ItemData[],
  ): Promise<ItemData[]> {
    if (!items || items.length === 0) return [];

    const startTime = Date.now();
    this.logger.log(`Starting AI deduplication for ${items.length} items`);

    // For small arrays, process directly
    if (items.length <= 50) {
      return this.processSingleDeduplicationBatch(description, items);
    }

    // For large arrays, use a chunking strategy
    return this.processLargeDeduplicationArray(description, items, startTime);
  }

  /**
   * Process a single batch of items for deduplication
   * @param description Description of the directory
   * @param items Items to deduplicate
   * @returns Deduplicated items
   */
  private async processSingleDeduplicationBatch(
    description: string,
    items: ItemData[],
  ): Promise<ItemData[]> {
    try {
      const prompt =
        HumanMessagePromptTemplate.fromTemplate(DEDUPLICATOR_PROMPT);

      const result = await prompt
        .pipe(this.llm.withStructuredOutput(extractedItemsSchema))
        .invoke({
          task: description,
          items: JSON.stringify(items.map(this.itemMap)),
        });

      return result.items.map((item) => {
        return <ItemData>{
          ...item,
          slug: slugifyText(item.name),
          category: '',
          tags: [],
        };
      });
    } catch (error) {
      this.logger.error(
        `Error during AI deduplication batch: ${error.message}`,
        error.stack,
      );
      // Fallback to the original items if AI deduplication fails
      return items;
    }
  }

  /**
   * Process a large array of items for deduplication using a chunking strategy
   * @param description Description of the directory
   * @param items Items to deduplicate
   * @param startTime Start time for logging
   * @returns Deduplicated items
   */
  private async processLargeDeduplicationArray(
    description: string,
    items: ItemData[],
    startTime: number,
  ): Promise<ItemData[]> {
    // Group similar items by name similarity to create more efficient chunks
    const groupedItems = this.groupSimilarItems(items);
    this.logger.log(
      `Grouped ${items.length} items into ${groupedItems.length} clusters for efficient processing`,
    );

    // Process each group in manageable chunks
    const CHUNK_SIZE = 50; // Optimal size for LLM processing
    let processedItems: ItemData[] = [];
    let totalProcessed = 0;

    // Process each group
    for (let groupIndex = 0; groupIndex < groupedItems.length; groupIndex++) {
      const group = groupedItems[groupIndex];

      // Skip empty groups
      if (!group || group.length === 0) continue;

      // Process large groups in chunks
      if (group.length > CHUNK_SIZE) {
        // Process the group in chunks
        const chunks = this.chunkArray(group, CHUNK_SIZE);
        let deduplicatedChunks: ItemData[] = [];

        // Process each chunk
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          this.logger.log(
            `Processing group ${groupIndex + 1}/${groupedItems.length}, chunk ${i + 1}/${chunks.length} (${chunk.length} items)`,
          );

          const deduplicatedChunk = await this.processSingleDeduplicationBatch(
            description,
            chunk,
          );
          deduplicatedChunks = deduplicatedChunks.concat(deduplicatedChunk);

          totalProcessed += chunk.length;
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          this.logger.log(
            `Progress: ${totalProcessed}/${items.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
          );

          // Add a small delay between chunks to avoid rate limiting
          if (i < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        // Deduplicate the chunks again if needed
        if (deduplicatedChunks.length > CHUNK_SIZE) {
          deduplicatedChunks = await this.processSingleDeduplicationBatch(
            description,
            deduplicatedChunks,
          );
        }

        processedItems = processedItems.concat(deduplicatedChunks);
      } else {
        // Process small groups directly
        this.logger.log(
          `Processing group ${groupIndex + 1}/${groupedItems.length} (${group.length} items)`,
        );
        const deduplicatedGroup = await this.processSingleDeduplicationBatch(
          description,
          group,
        );
        processedItems = processedItems.concat(deduplicatedGroup);

        totalProcessed += group.length;
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        this.logger.log(
          `Progress: ${totalProcessed}/${items.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
        );
      }

      // Add a small delay between groups to avoid rate limiting
      if (groupIndex < groupedItems.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Step 3: Final deduplication pass if needed
    if (processedItems.length > CHUNK_SIZE) {
      // Use field-based deduplication first to reduce size
      processedItems = this.deduplicateByField(
        this.deduplicateByField(processedItems, 'slug'),
        'source_url',
      );

      // If still large, use a final AI pass with increased chunk size
      if (processedItems.length > CHUNK_SIZE * 2) {
        const finalChunks = this.chunkArray(processedItems, CHUNK_SIZE * 2);
        let finalProcessedItems: ItemData[] = [];

        for (let i = 0; i < finalChunks.length; i++) {
          this.logger.log(
            `Final deduplication pass: chunk ${i + 1}/${finalChunks.length} (${finalChunks[i].length} items)`,
          );
          const deduplicatedChunk = await this.processSingleDeduplicationBatch(
            description,
            finalChunks[i],
          );
          finalProcessedItems = finalProcessedItems.concat(deduplicatedChunk);

          // Add a small delay between chunks
          if (i < finalChunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        processedItems = finalProcessedItems;
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    this.logger.log(
      `Completed AI deduplication: ${items.length} items → ${processedItems.length} items in ${totalTime.toFixed(1)}s`,
    );

    return processedItems;
  }

  /**
   * Group similar items together to improve deduplication efficiency
   * @param items Items to group
   * @returns Array of item groups
   */
  private groupSimilarItems(items: ItemData[]): ItemData[][] {
    // Create a simple grouping based on the first letter of the name
    // This is a basic approach that can be enhanced with more sophisticated clustering
    const groups: Map<string, ItemData[]> = new Map();

    for (const item of items) {
      if (!item.name) continue;

      // Get the first letter or character
      const firstChar = item.name.charAt(0).toLowerCase();

      // Group by first letter
      if (!groups.has(firstChar)) {
        groups.set(firstChar, []);
      }
      groups.get(firstChar)!.push(item);
    }

    // Convert map to array of groups
    return Array.from(groups.values());
  }

  /**
   * Split an array into chunks of specified size
   * @param array Array to split
   * @param chunkSize Size of each chunk
   * @returns Array of chunks
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Extracts new items that don't exist in the existing items
   * @param existingItems Existing items
   * @param newItems New items to filter
   * @returns New items that don't exist in the existing items
   */
  private async extractNewItems(
    existingItems: ItemData[],
    newItems: ItemData[],
  ): Promise<ItemData[]> {
    if (!newItems || newItems.length === 0) return [];
    if (!existingItems || existingItems.length === 0) return newItems;

    const startTime = Date.now();
    this.logger.log(
      `Starting new items extraction: comparing ${newItems.length} new items against ${existingItems.length} existing items`,
    );

    // For small arrays, process directly
    if (newItems.length <= 50) {
      return this.processSingleExtractionBatch(existingItems, newItems);
    }

    // For large arrays, use a chunking strategy
    return this.processLargeExtractionArray(existingItems, newItems, startTime);
  }

  /**
   * Process a single batch of items for extraction
   * @param existingItems Existing items
   * @param newItems New items to filter
   * @returns New items that don't exist in the existing items
   */
  private async processSingleExtractionBatch(
    existingItems: ItemData[],
    newItems: ItemData[],
  ): Promise<ItemData[]> {
    try {
      const prompt = HumanMessagePromptTemplate.fromTemplate(
        EXTRACT_NEW_ITEMS_PROMPT,
      );

      const result = await prompt
        .pipe(this.llm.withStructuredOutput(extractedItemsSchema))
        .invoke({
          existing: JSON.stringify(existingItems.map(this.itemMap)),
          new: JSON.stringify(newItems.map(this.itemMap)),
        });

      return result.items.map((item) => {
        return <ItemData>{
          ...item,
          slug: slugifyText(item.name),
          category: '',
          tags: [],
        };
      });
    } catch (error) {
      this.logger.error(
        `Error during new items extraction batch: ${error.message}`,
        error.stack,
      );
      // Fallback to the new items if AI extraction fails
      return newItems;
    }
  }

  /**
   * Process a large array of items for extraction using a chunking strategy
   * @param existingItems Existing items
   * @param newItems New items to filter
   * @param startTime Start time for logging
   * @returns New items that don't exist in the existing items
   */
  private async processLargeExtractionArray(
    existingItems: ItemData[],
    newItems: ItemData[],
    startTime: number,
  ): Promise<ItemData[]> {
    // Step 1: Group similar items by name similarity to create more efficient chunks
    const groupedItems = this.groupSimilarItems(newItems);
    this.logger.log(
      `Grouped ${newItems.length} new items into ${groupedItems.length} clusters for efficient processing`,
    );

    // Step 2: Process each group in manageable chunks
    const CHUNK_SIZE = 50; // Optimal size for LLM processing
    let extractedItems: ItemData[] = [];
    let totalProcessed = 0;

    // Process each group
    for (let groupIndex = 0; groupIndex < groupedItems.length; groupIndex++) {
      const group = groupedItems[groupIndex];

      // Skip empty groups
      if (!group || group.length === 0) continue;

      // Process large groups in chunks
      if (group.length > CHUNK_SIZE) {
        // Process the group in chunks
        const chunks = this.chunkArray(group, CHUNK_SIZE);
        let extractedChunks: ItemData[] = [];

        // Process each chunk
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          this.logger.log(
            `Processing group ${groupIndex + 1}/${groupedItems.length}, chunk ${i + 1}/${chunks.length} (${chunk.length} items)`,
          );

          const extractedChunk = await this.processSingleExtractionBatch(
            existingItems,
            chunk,
          );
          extractedChunks = extractedChunks.concat(extractedChunk);

          totalProcessed += chunk.length;
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          this.logger.log(
            `Progress: ${totalProcessed}/${newItems.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
          );

          // Add a small delay between chunks to avoid rate limiting
          if (i < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        extractedItems = extractedItems.concat(extractedChunks);
      } else {
        // Process small groups directly
        this.logger.log(
          `Processing group ${groupIndex + 1}/${groupedItems.length} (${group.length} items)`,
        );
        const extractedGroup = await this.processSingleExtractionBatch(
          existingItems,
          group,
        );
        extractedItems = extractedItems.concat(extractedGroup);

        totalProcessed += group.length;
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        this.logger.log(
          `Progress: ${totalProcessed}/${newItems.length} items processed in ${elapsedSeconds.toFixed(1)}s`,
        );
      }

      // Add a small delay between groups to avoid rate limiting
      if (groupIndex < groupedItems.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Step 3: Final deduplication pass to ensure no duplicates in the result
    extractedItems = this.deduplicateByField(
      this.deduplicateByField(extractedItems, 'slug'),
      'source_url',
    );

    const totalTime = (Date.now() - startTime) / 1000;
    this.logger.log(
      `Completed new items extraction: ${newItems.length} items → ${extractedItems.length} new items in ${totalTime.toFixed(1)}s`,
    );

    return extractedItems;
  }

  private itemMap(item: ItemData) {
    return {
      name: item.name,
      description: item.description,
      url: item.source_url,
    };
  }
}

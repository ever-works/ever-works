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
   * Deduplicates items using AI
   * @param description Description of the directory
   * @param items Items to deduplicate
   * @returns Deduplicated items
   */
  private async deduplicateWithAI(
    description: string,
    items: ItemData[],
  ): Promise<ItemData[]> {
    if (!items || items.length === 0) return [];

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
        `Error during AI deduplication: ${error.message}`,
        error.stack,
      );
      // Fallback to the original items if AI deduplication fails
      return items;
    }
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
        `Error during new items extraction: ${error.message}`,
        error.stack,
      );
      // Fallback to the new items if AI extraction fails
      return newItems;
    }
  }

  private itemMap(item: ItemData) {
    return {
      name: item.name,
      description: item.description,
      url: item.source_url,
    };
  }
}

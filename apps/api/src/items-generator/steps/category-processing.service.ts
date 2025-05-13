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
You are directory website builder and your task is to categorize items based on their features and descriptions.
Take a look at task given by user as it may contain some hints about categories:
<task>
{task}
</task>

Here is the list of items to categorize:
<items>
{items}
</items>

<instructions>
1. Assign each item to ONE appropriate category based on its primary function or purpose.
2. Choose concise, descriptive category names that clearly represent groups of similar items.
3. Assign 2-5 relevant tags to each item that highlight key features, technologies, or use cases.
4. Ensure categories are consistent and at a similar level of abstraction.
5. For software/tools, good category examples include: "Monitoring", "CI/CD", "Data Visualization", "Testing", etc.
6. For tags, good examples include: "open-source", "real-time", "cloud-native", "enterprise", etc.
7. Avoid overly broad categories like "Tools" or "Software" - be more specific.
8. Avoid overly specific categories that would only contain 1-2 items.
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
    this.llm = this.aiService.createLlmWithTemperature(0.3); // Use temperature 0.3 for some creativity in categorization
  }

  /**
   * Process items to generate categories and tags
   * @param createItemsGeneratorDto The DTO containing the description
   * @param extractedItems The items to categorize
   * @returns Object containing categorized items, categories, and tags
   */
  async processCategoriesAndTags(
    createItemsGeneratorDto: CreateItemsGeneratorDto,
    extractedItems: Partial<ItemData>[],
  ) {
    const { slug, description } = createItemsGeneratorDto;
    this.logger.log(
      `[${slug}] Starting category and tag processing for ${extractedItems.length} items`,
    );

    // Track metrics
    const startTime = Date.now();

    if (!extractedItems || extractedItems.length === 0) {
      this.logger.log(`[${slug}] No items to categorize`);
      return { finalItems: [], categories: [], tags: [] };
    }

    try {
      // Categorize items using AI
      const categorized = await this.categorizeItems(
        description,
        extractedItems,
      );
      this.logger.log(
        `[${slug}] Successfully categorized ${categorized.length} items`,
      );

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
   * @returns Categorized items
   */
  private async categorizeItems(
    description: string,
    items: Partial<ItemData>[],
  ): Promise<ItemData[]> {
    if (!items || items.length === 0) return [];

    try {
      // Prepare items for categorization
      const itemsForCategorization = items.map((i) => ({
        slug: i.slug,
        name: i.name,
        description: i.description,
        url: i.source_url,
      }));

      // Process in batches if there are many items
      if (items.length > 50) {
        return this.processBatchCategorization(
          description,
          itemsForCategorization,
        );
      }

      // Process all items at once if the count is reasonable
      const prompt = HumanMessagePromptTemplate.fromTemplate(CATEGORIZE_PROMPT);
      const result = await prompt
        .pipe(this.llm.withStructuredOutput(categorizeOutputSchema))
        .invoke({
          task: description,
          items: JSON.stringify(itemsForCategorization),
        });

      return result.items as ItemData[];
    } catch (error) {
      this.logger.error(
        `Error during AI categorization: ${error.message}`,
        error.stack,
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
   * @param description Description of the directory
   * @param items Items to categorize
   * @returns Categorized items
   */
  private async processBatchCategorization(
    description: string,
    items: any[],
  ): Promise<ItemData[]> {
    const BATCH_SIZE = 30;
    const allCategorizedItems: ItemData[] = [];

    // Process items in batches
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      this.logger.log(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)`,
      );

      try {
        const prompt =
          HumanMessagePromptTemplate.fromTemplate(CATEGORIZE_PROMPT);
        const result = await prompt
          .pipe(this.llm.withStructuredOutput(categorizeOutputSchema))
          .invoke({
            task: description,
            items: JSON.stringify(batch),
          });

        allCategorizedItems.push(...(result.items as ItemData[]));

        // Add a small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < items.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        this.logger.error(
          `Error during batch categorization: ${error.message}`,
          error.stack,
        );

        // Fallback for this batch
        const fallbackItems = batch.map((item) => ({
          ...item,
          category: 'others',
          tags: [],
          slug: item.slug || slugifyText(item.name),
        })) as ItemData[];

        allCategorizedItems.push(...fallbackItems);
      }
    }

    return allCategorizedItems;
  }

  /**
   * Extract unique categories from categorized items
   * @param items Categorized items
   * @returns Array of unique categories
   */
  private extractUniqueCategories(items: ItemData[]): Category[] {
    const categoryNames = items.map((item) => item.category as string);
    return this.mapUnique(categoryNames);
  }

  /**
   * Extract unique tags from categorized items
   * @param items Categorized items
   * @returns Array of unique tags
   */
  private extractUniqueTags(items: ItemData[]): Tag[] {
    const tagNames = items.flatMap((item) => item.tags as string[]);
    return this.mapUnique(tagNames);
  }

  /**
   * Map an array of names to unique identifiable objects
   * @param names Array of names
   * @returns Array of unique identifiable objects
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
   * @returns Complete ItemData object
   */
  private toItemData(item: Partial<ItemData>): ItemData {
    return {
      name: item.name,
      description: item.description,
      source_url: item.source_url,
      category: slugifyText(item.category as string),
      tags: Array.isArray(item.tags)
        ? item.tags.map((tag: any) =>
            slugifyText(typeof tag === 'string' ? tag : tag.name),
          )
        : [],
      slug: item.slug || slugifyText(item.name),
    };
  }
}

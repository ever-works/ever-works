import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { InputItem, ItemData } from './types';
import { formatItemsForPrompt } from './categorize';

// Should be the same structure as deduplicateOutputSchema or ItemData
const filterNewItemsOutputSchema = z.object({
  items: z
    .array(
      z.object({
        slug: z.string().describe('The original unique slug of the new item.'),
        name: z.string().describe('The original name of the new item.'),
        description: z
          .string()
          .describe('The original description of the new item.'),
        source_url: z
          .string()
          .url()
          .optional()
          .describe('The original URL (optional).'),
        category: z
          .string()
          .optional()
          .describe('The original category (optional).'),
        tags: z
          .array(z.string())
          .optional()
          .describe('The original tags (optional).'),
      }),
    )
    .describe(
      'The list of NEW items that DO NOT have duplicates in the existing list.',
    ),
});

export type FilterNewItemsResult = z.infer<typeof filterNewItemsOutputSchema>;

const FILTER_NEW_ITEMS_PROMPT_TEMPLATE = `Your task is to filter a list of 'new' items, keeping only those that DO NOT have a duplicate in the 'existing' items list.

Comparison Rules:
- Compare each 'new' item against ALL items in the 'existing' list.
- Use name similarity (case-insensitive, handle variants like '.js', 'Desktop', 'X by Y') and source URLs for comparison.
- If a 'new' item is considered a duplicate of ANY item in the 'existing' list, it should be EXCLUDED from the output.

Examples of items to treat as duplicates for comparison:
- "React" vs "React.js"
- "Pandas 2.5" vs "Pandas"
- "express" vs "Express"
- "Docker" vs "Docker Desktop"
- "X by Y" vs "X"

List of Existing Items (Reference for comparison):
<existing_items>
{formatted_existing_items}
</existing_items>

List of New Items (Filter these):
<new_items>
{formatted_new_items}
</new_items>

Output ONLY the items from the 'new_items' list that were determined to be unique (i.e., not duplicates of anything in 'existing_items').
**Crucially: For each unique new item returned, preserve ALL of its original fields: slug, name, description, source_url, category, and tags.** Do not modify the data of the returned items. Ensure the output follows the required JSON schema.`;

/**
 * Filters a list of new items, returning only those not found in the existing items list.
 *
 * @param existingItems The list of items already known.
 * @param newItems The list of new items to check.
 * @returns A promise resolving to a list of new items that are unique compared to existing items.
 */
export async function filterNewItems(
  existingItems: InputItem[],
  newItems: InputItem[],
): Promise<ItemData[]> {
  const loggerContext = 'AgentFilterNew';
  if (!newItems || newItems.length === 0) {
    Logger.log('No new items provided for filtering.', loggerContext);
    return []; // No new items to filter
  }
  if (!existingItems || existingItems.length === 0) {
    Logger.log(
      'No existing items provided; returning all new items.',
      loggerContext,
    );
    // If there's nothing to compare against, all new items are unique in this context
    // Map to ItemData structure for consistency
    return newItems.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      source_url: item.source_url || undefined,
      category: item.category || undefined,
      tags: item.tags || undefined,
    }));
  }

  Logger.log(
    `Starting filtering for ${newItems.length} new items against ${existingItems.length} existing items.`,
    loggerContext,
  );

  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.0,
  });

  const formattedExistingItems = formatItemsForPrompt(existingItems);
  const formattedNewItems = formatItemsForPrompt(newItems);
  const prompt = HumanMessagePromptTemplate.fromTemplate(
    FILTER_NEW_ITEMS_PROMPT_TEMPLATE,
  );

  try {
    const result: FilterNewItemsResult = await prompt
      .pipe(llm.withStructuredOutput(filterNewItemsOutputSchema))
      .invoke({
        formatted_existing_items: formattedExistingItems,
        formatted_new_items: formattedNewItems,
      });

    Logger.log(
      `LLM returned ${result.items.length} unique new items after filtering.`,
      loggerContext,
    );

    // Map result to ensure it conforms to ItemData
    // No slug regeneration needed.
    const finalItems: ItemData[] = result.items.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      source_url: item.source_url || undefined,
      category: item.category || undefined,
      tags: item.tags || undefined,
    }));

    return finalItems;
  } catch (error) {
    Logger.error(
      `Error during LLM filtering of new items: ${error.message}`,
      error.stack,
      loggerContext,
    );
    return [];
  }
}

// It should return items matching the full expected structure
const deduplicateOutputSchema = z.object({
  items: z
    .array(
      z.object({
        slug: z
          .string()
          .describe(
            'The original unique slug of the chosen representative item.',
          ),
        name: z
          .string()
          .describe(
            'The name of the item (prefer shorter/base name if duplicates merged).',
          ),
        description: z.string().describe('The description of the item.'),
        source_url: z.string().url().optional().describe('The URL (optional).'),
        category: z.string().optional().describe('The category (optional).'),
        tags: z.array(z.string()).optional().describe('The tags (optional).'),
      }),
    )
    .describe('The deduplicated list of items, preserving original fields.'),
});

export type DeduplicationResult = z.infer<typeof deduplicateOutputSchema>;

const DEDUPLICATE_PROMPT_TEMPLATE = `Your task is to deduplicate the provided list of items. Analyze the items based on their names and source URLs to identify duplicates.

Rules for Deduplication:
- Compare items primarily by name similarity and source URL.
- Consider items with slightly different names but representing the same core entity as duplicates (e.g., "React" vs "React.js", "Pandas 2.5" vs "Pandas", "X by Y" vs "X").
- Prefer shorter, base names when merging duplicates (e.g., use "Pandas" instead of "Pandas 2.5").
- If items are duplicates, choose ONE representative item to keep.
- **Crucially: Preserve the original 'slug' and all other fields (description, category, tags) of the item you choose to keep.** Do not invent new data.

Examples of items to treat as duplicates:
- "React" and "React.js"
- "Pandas 2.5" and "Pandas"
- "express" and "Express" (case-insensitive comparison)
- "Docker" and "Docker Desktop"
- "X by Y" and "X"

Input List of Items to Deduplicate:
<items>
{formatted_items}
</items>

Output the final, deduplicated list of items, ensuring each item includes its original slug, name, description, source_url (if present), category (if present), and tags (if present), according to the required JSON schema.`;

/**
 * Deduplicates items within a single list based on name and URL similarity.
 * Preserves the original slug and other data of the kept items.
 *
 * @param inputItems The list of items to deduplicate.
 * @returns A promise resolving to the deduplicated list of items.
 */
export async function deduplicateItems(
  inputItems: InputItem[],
): Promise<ItemData[]> {
  const loggerContext = 'AgentDeduplicate';
  if (!inputItems || inputItems.length === 0) {
    Logger.log('No items provided for deduplication.', loggerContext);
    return [];
  }
  Logger.log(
    `Starting deduplication for ${inputItems.length} items.`,
    loggerContext,
  );

  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.0,
  });

  const formattedItems = formatItemsForPrompt(inputItems);
  const prompt = HumanMessagePromptTemplate.fromTemplate(
    DEDUPLICATE_PROMPT_TEMPLATE,
  );

  try {
    const result: DeduplicationResult = await prompt
      .pipe(llm.withStructuredOutput(deduplicateOutputSchema))
      .invoke({
        formatted_items: formattedItems,
      });

    Logger.log(
      `LLM returned ${result.items.length} items after deduplication.`,
      loggerContext,
    );

    // Map result to ensure it conforms to ItemData, handle optional fields correctly
    // No need to regenerate slug here - LLM was instructed to preserve it.
    const finalItems: ItemData[] = result.items.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      source_url: item.source_url || undefined,
      category: item.category || undefined,
      tags: item.tags || undefined,
    }));

    return finalItems;
  } catch (error) {
    Logger.error(
      `Error during LLM deduplication: ${error.message}`,
      error.stack,
      loggerContext,
    );
    return [];
  }
}

import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { Logger } from '@nestjs/common';
import { InputItem, ItemData } from './types';
import { z } from 'zod';
import * as process from 'process';

export const categorizeOutputSchema = z.object({
  items: z
    .array(
      z.object({
        slug: z
          .string()
          .describe('Unique identifier slug for the item (must match input).'),
        name: z.string().describe('The name of the item (should match input).'),
        description: z
          .string()
          .describe('The description of the item (should match input).'),
        source_url: z
          .string()
          .nullable()
          .describe(
            'The original source URL, if available (should match input).',
          ),
        category: z
          .string()
          .describe(
            'The assigned category for the item (e.g., "Web Server", "Data Visualization", or "Uncategorized").',
          ),
        tags: z
          .array(z.string())
          .nullable()
          .describe(
            'Original tags associated with the item (should match input).',
          ),
      }),
    )
    .describe(
      'An array containing all input items, each updated with an assigned category.',
    ),
});

// --- Prompt Template ---
const CATEGORIZE_PROMPT_TEMPLATE = `Your task is to assign the most relevant category to each item listed below, considering the overall goal described in the Task Context.

Task Context (for theme guidance): <task>{task}</task>

Items to Categorize:
<items>
{formatted_items}
</items>

Instructions:
- Analyze each item's name, description, source URL (if provided), and existing tags/category to understand its purpose.
- Use the Task Context to determine relevant and consistent category themes for the *entire list*.
- **Assign the single most fitting category to *each* item based on the Task Context and item details.** Use title case (e.g., "Web Server", "Database Tool").
- **Re-evaluate the category for every item.** Do not simply copy the 'Existing Category' if one is present; assign the best category based on *your* analysis and the Task Context.
- If an item cannot be reasonably categorized based on the context, assign the category "Uncategorized".
- Ensure the output strictly follows the required JSON schema, providing a category for every input item. Match the output 'slug' to the input 'slug' for each item.
- Preserve all other original item fields (slug, name, description, source_url, tags) in the output.`;

// --- Helper Function ---
export function formatItemsForPrompt(items: InputItem[]): string {
  if (!items || items.length === 0) {
    return 'No items provided.';
  }
  return items
    .map((item) => {
      let itemStr = `- Item (slug: ${item.slug}):\n`;
      itemStr += `  Name: ${item.name || 'N/A'}\n`;
      itemStr += `  Description: ${item.description || 'N/A'}\n`;
      if (item.category) {
        // Include existing category
        itemStr += `  Existing Category: ${item.category}\n`;
      }
      if (item.tags && item.tags.length > 0) {
        itemStr += `  Existing Tags: [${item.tags.join(', ')}]\n`;
      }
      if (item.source_url) {
        // Include source URL
        itemStr += `  Source URL: ${item.source_url}\n`;
      }
      return itemStr;
    })
    .join('---\n');
}

// --- Main Categorization Function ---
export async function categorizeItems(
  task: string,
  inputItems: InputItem[],
): Promise<ItemData[]> {
  if (!inputItems || inputItems.length === 0) {
    Logger.log('No items provided for categorization.', 'AgentCategorize');
    return [];
  }

  const loggerContext = 'AgentCategorize';
  Logger.log(
    `Starting categorization for ${inputItems.length} items. Task: "${task}"`,
    loggerContext,
  );

  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4.1',
    temperature: 0.2,
  });

  const formattedItems = formatItemsForPrompt(inputItems);
  const prompt = HumanMessagePromptTemplate.fromTemplate(
    CATEGORIZE_PROMPT_TEMPLATE,
  );

  try {
    const result = await prompt
      .pipe(llm.withStructuredOutput(categorizeOutputSchema))
      .invoke({
        task: task,
        formatted_items: formattedItems,
      });

    Logger.log(
      `LLM returned ${result.items.length} categorized items.`,
      loggerContext,
    );

    if (result.items.length !== inputItems.length) {
      Logger.warn(
        `Mismatch in item count: Input (${inputItems.length}), Output (${result.items.length}). Returning raw LLM output.`,
        loggerContext,
      );
    }

    // Map to ItemData, ensuring required 'category' is present
    const categorizedItems: ItemData[] = result.items.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      source_url: item.source_url,
      category: item.category,
      tags: item.tags,
    }));

    return categorizedItems;
  } catch (error) {
    Logger.error(
      `Error during LLM categorization: ${error.message}`,
      error.stack,
      loggerContext,
    );

    return [];
  }
}

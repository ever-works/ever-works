import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { Logger } from '@nestjs/common';
import slugify from 'slugify';
import { z } from 'zod';

// Schema remains the same - it's well-defined
const outputSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        source_url: z
          .string()
          .nullable()
          .describe('The URL of item`s official website/repository'),
        category: z.string().nullable().describe('The category of the item'),
        tags: z.array(z.string()).nullable().describe('The tags of the item'),
      }),
    )
    .describe('An array of extracted items relevant to the task.'),
});

// The improved prompt
const EXTRACTION_PROMPT = `Extract structured items relevant to the task from the research text.

Task: <task>{task}</task>
Research Text: <research_content>{research_content}</research_content>

Instructions:
- Identify all distinct items (e.g., software, resources, servers) described in the research text that match the task.
- For each item, extract the required fields (name, description, source_url, category, tags).
- Ignore irrelevant content and focus solely on extracting items from the provided text.
- Ensure the output matches the requested structured format.`;

// Renamed function and variable
export async function generateItemsSubarray(
  task: string,
  sourceUrl: string,
  researchContent: string,
) {
  Logger.log(`Extracting items from ${sourceUrl}`, 'Agent');
  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4.1',
    temperature: 0.1,
  });

  const prompt = HumanMessagePromptTemplate.fromTemplate(EXTRACTION_PROMPT);

  try {
    const result = await prompt
      .pipe(llm.withStructuredOutput(outputSchema))
      .invoke({
        task,
        research_content: researchContent,
      });

    Logger.log(
      `Extracted ${result.items.length} items from "${sourceUrl}"`,
      'Agent',
    );

    // Post-processing remains the same
    return result.items.map((item) => ({
      ...item,
      slug: slugify(item.name, { lower: true, trim: true }),
      source_url: item.source_url ? item.source_url.replace(/\/$/, '') : null,
    }));
  } catch (error) {
    Logger.error(
      `Failed to extract items from "${sourceUrl}": ${error}`,
      'Agent',
    );

    return [];
  }
}

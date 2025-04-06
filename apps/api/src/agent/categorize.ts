import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import { ItemData } from "./types";
import { z } from "zod";

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
`.trim();

export const categorizeOutputSchema = z.object({
    items: z.array(
        z.object({
            slug: z.string(),
            name: z.string(),
            description: z.string(),
            source_url: z.string().optional().describe('The URL of item`s official website/repository'),
            category: z.string().optional().describe('The category of the item make it start with uppercase letter'),
            tags: z.array(z.string()).optional().describe('The tags of the item make them start with uppercase letter'),
        })
    ),
});

/**
 * Categorizes items based on their features and descriptions.
 *
 * @param task User's prompt.
 * @param items The items to categorize.
 * @returns An array of items with categories.
 */
export async function categorize(task: string, items: object[]): Promise<ItemData[]> {
    Logger.log(`Categorizing items with length: ${items.length}`, 'Agent');
    const llm = new ChatOpenAI({
        model: 'gpt-4o',
        temperature: 0.3,
    });

    const prompt = HumanMessagePromptTemplate.fromTemplate(CATEGORIZE_PROMPT);
    const result = await prompt
        .pipe(llm.withStructuredOutput(categorizeOutputSchema))
        .invoke({
            task,
            items: JSON.stringify(items),
        });
    
    Logger.log(`Got ${result.items.length} after categorization with LLM`, 'Agent');
    return result.items as ItemData[];
}

import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import { ItemData } from "./types";
import { z } from "zod";
import { itemDataWithCategoriesAndTagsSchema } from "./schemas";

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
    items: z.array(itemDataWithCategoriesAndTagsSchema),
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
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
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

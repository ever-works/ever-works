import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import slugify from "slugify";
import { z } from "zod";
import { ItemData } from "./types";
import { categorizeOutputSchema } from "./categorize";

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
We don't want to show duplicates to our users, so return only new items that dont't exist in existing items list.

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

const outputSchema = z.object({
    items: z.array(
        z.object({
            name: z.string(),
            description: z.string(),
            source_url: z.string().optional().describe('The URL of item`s official website/repository'),
        })
    ),
});

export async function deduplicate(task: string, items: object[]) {
    Logger.log(`Deduplicating items with length: ${items.length}`, 'Agent');
    const llm = new ChatOpenAI({
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
        temperature: 0.0,
    });

    const prompt = HumanMessagePromptTemplate.fromTemplate(DEDUPLICATOR_PROMPT);
    const result = await prompt
        .pipe(llm.withStructuredOutput(outputSchema))
        .invoke({
            task,
            items: JSON.stringify(items),
        });
    
    Logger.log(`Got ${result.items.length} after deduplication with LLM`, 'Agent');
    return result.items.map(item => ({ slug: slugify(item.name, { lower: true, trim: true }), ...item }));
}

export async function extractNewItems(existingItems: Partial<ItemData>[], newItems: Partial<ItemData>[]) {
    Logger.log(`Extracting new items with length: ${newItems.length}`, 'Agent');
    const llm = new ChatOpenAI({
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
        temperature: 0.0,
    });

    const prompt = HumanMessagePromptTemplate.fromTemplate(EXTRACT_NEW_ITEMS_PROMPT);
    const result = await prompt
        .pipe(llm.withStructuredOutput(categorizeOutputSchema))
        .invoke({
            existing: JSON.stringify(existingItems),
            new: JSON.stringify(newItems),
        });

    Logger.log(`Got ${result.items.length} after extracting new items with LLM`, 'Agent');
    return result.items.map(item => ({ slug: slugify(item.name, { lower: true, trim: true }), ...item }));
}

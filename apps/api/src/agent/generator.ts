import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import slugify from "slugify";
import { z } from "zod";

const GENERATOR_PROMPT = `
You are directory website builder and your task is to generate items to be displayed on the website, based on given task:
<task>
{task}
</task>

Here is the research context, make sure you extract all relevant items and informations from research data.
Some content might be invalid or irrelevant, make sure to exclude them and align with the task.
<research>
{research}
</research>
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

export async function generateItemsSubarray(task: string, url: string, research: string) {
    Logger.log(`Generating items from ${url}`, 'Agent');
    const llm = new ChatOpenAI({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0.0,
    });

    const prompt = HumanMessagePromptTemplate.fromTemplate(GENERATOR_PROMPT);
    const result = await prompt
        .pipe(llm.withStructuredOutput(outputSchema))
        .invoke({
            task,
            research,
        });
    
    Logger.log(`Generated ${result.items.length} items from "${url}"`, 'Agent');
    return result.items.map(item => ({ slug: slugify(item.name, { lower: true, trim: true }), ...item, source_url: item.source_url?.replace(/\/$/, '') }));
}

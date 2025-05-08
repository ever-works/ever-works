import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import { ItemData } from "./types";
import { z } from "zod";
import { extractContentFrom } from "./tavily";

export const MARKDOWN_PROMPT = `
You are directory website builder and your task is to generate markdown summary for item:
<item>
{item}
</item>

<rules>
1. Many websites will contain marketing language, make sure to extract only relevant information.
2. Exclude anything related to Testimonials, "Why Choose" specific product and other marketing / sales details.
3. No need to include any info about "Support" if item is a product.
4. Make sure we output ALL features (as much as possible) of the item inside "Features" block, not only Key Features.
5. If item is a product/service, make sure to include "Pricing" block with all available plans (if provided content contains it).
</rules>

Based on this website content:
<content>
{content}
</content>
`.trim();

export const markdownOutputSchema = z.object({
    markdown: z.string(),
});

/**
 * Generates markdown summary for a given item.
 *
 * @param item The item.
 * @returns A markdown string with item's summary.
 */
export async function markdown(item: Partial<ItemData>): Promise<string> {
    Logger.log(`Generating markdown for: ${item.slug}`, 'Agent');
    const content = await extractContentFrom(item.source_url);
    if (!content) {
        Logger.warn(`Failed to extract content from: "${item.source_url}"`, 'Agent');
        return;
    }

    const llm = new ChatOpenAI({
        model: process.env.OPENAI_MODEL || 'gpt-4.1',
        temperature: 0.6,
    });

    const prompt = HumanMessagePromptTemplate.fromTemplate(MARKDOWN_PROMPT);
    const result = await prompt
        .pipe(llm.withStructuredOutput(markdownOutputSchema))
        .invoke({
            item: JSON.stringify(item),
            content: content.rawContent,
        });
    
    return result.markdown;
}

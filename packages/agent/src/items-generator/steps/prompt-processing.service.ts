import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { BaseChatModel, ModelRouterService, TaskComplexity } from 'src/ai';

// Prompt processing prompt
const PROMPT_PROCESSING_PROMPT = `
# Prompt Extraction and Rewriting Task

You extract URLs, categories, priority indicators, and featured item specifications from user prompts, then rewrite the prompt to focus only on the core task.

## Extraction Rules

### 1. URLs
Extract only explicitly mentioned URLs from the prompt.

### 2. Categories
Extract categories when explicitly mentioned with phrases like:
- "categories like X, Y, Z"
- "organize into categories: X, Y, Z"
- "categorize as X, Y, Z"

**Do NOT extract:**
- General descriptive terms
- Context examples not intended as categories
- Terms from prompts like "best time tracking for businesses" (where "businesses" is descriptive, not a category)

### 3. Priority Categories
Extract categories with priority indicators:
- "start with X" / "X first" / "X should come first"
- "prioritize X" / "X is priority"
- "most important is X"
- Numbered lists indicating order (1. X, 2. Y)

**Note:** Priority categories should also appear in the regular categories list.

### 4. Featured Items
Extract specifications for items that should be highlighted:
- "highlight X" / "feature X" / "showcase X"
- "X should be featured" / "emphasize X"
- "top X" / "best X" / "leading X"
- "popular X" / "recommended X"
- Specific named items (e.g., "highlight Docker and Kubernetes")
- Company-specific products when mentioned

## Prompt Rewriting

Remove ALL of the following while preserving the core task:
- URLs and reference instructions
- Category specifications and hints
- Priority indicators
- Featured item specifications
- Categorization instructions (e.g., "use license type as tag")

Combine separated instructions into a single, coherent task description.

**Output:** Clean prompt containing only essential task instructions.

## Input Format

<prompt>
{user_prompt}
</prompt>

## Output Format

Return:
1. Extracted URLs
2. Suggested categories (explicitly mentioned)
3. Priority categories (with priority indicators)
4. Featured item hints
5. Rewritten prompt (core task only)`;

// Output schema for validation
const promptProcessingOutputSchema = z.object({
    extractedUrls: z.array(z.string()).describe('List of URLs extracted from the prompt'),
    suggestedCategories: z
        .array(z.string())
        .describe('List of category hints extracted from the prompt'),
    priorityCategories: z
        .array(z.string())
        .describe(
            'List of categories that should appear first in the final output, extracted from priority indicators in the prompt',
        ),
    featuredItemHints: z
        .array(z.string())
        .describe(
            'List of specifications about which items should be featured/highlighted, extracted from prominence indicators in the prompt',
        ),
    rewrittenPrompt: z
        .string()
        .describe('The prompt rewritten without URLs but preserving context'),
});

@Injectable()
export class PromptProcessingService {
    private readonly logger = new Logger(PromptProcessingService.name);
    private llm: BaseChatModel;

    constructor(private readonly modelRouter: ModelRouterService) {
        this.llm = this.modelRouter.getModel(TaskComplexity.SIMPLE, { temperature: 0 });
    }

    /**
     * Extract URLs, category hints, priority categories, and featured item hints from a prompt and rewrite the prompt without URLs
     * @param slug The slug for logging purposes
     * @param prompt The prompt to extract URLs and categories from
     * @returns Object containing extracted URLs, suggested categories, priority categories, featured item hints, and rewritten prompt
     */
    async processPrompt(
        slug: string,
        prompt: string,
    ): Promise<{
        extractedUrls: string[];
        suggestedCategories: string[];
        priorityCategories: string[];
        featuredItemHints: string[];
        rewrittenPrompt: string;
    }> {
        if (!prompt) {
            this.logger.warn(`[${slug}] No prompt provided for processing`);
            return {
                extractedUrls: [],
                suggestedCategories: [],
                priorityCategories: [],
                featuredItemHints: [],
                rewrittenPrompt: prompt || '',
            };
        }

        // Use AI for sophisticated extraction of URLs and categories
        try {
            this.logger.log(`[${slug}] Using AI to process prompt for URLs and categories`);

            const promptTemplate =
                HumanMessagePromptTemplate.fromTemplate(PROMPT_PROCESSING_PROMPT);

            const result = await promptTemplate
                .pipe(this.llm.withStructuredOutput(promptProcessingOutputSchema))
                .invoke({ user_prompt: prompt });

            const {
                extractedUrls,
                suggestedCategories,
                priorityCategories,
                featuredItemHints,
                rewrittenPrompt,
            } = result;

            this.logger.log(
                `[${slug}] AI extracted ${extractedUrls.length} URLs, ${suggestedCategories.length} category hints, ${priorityCategories.length} priority categories, and ${featuredItemHints.length} featured item hints from prompt`,
            );

            const validatedUrls = this.validateUrls(extractedUrls);
            const cleanedCategories = this.cleanCategories(suggestedCategories);
            const cleanedPriorityCategories = this.cleanCategories(priorityCategories);
            const cleanedFeaturedItemHints = this.cleanCategories(featuredItemHints);

            return {
                extractedUrls: validatedUrls,
                suggestedCategories: cleanedCategories,
                priorityCategories: cleanedPriorityCategories,
                featuredItemHints: cleanedFeaturedItemHints,
                rewrittenPrompt: validatedUrls.length > 0 ? rewrittenPrompt || prompt : prompt,
            };
        } catch (error) {
            this.logger.error(`[${slug}] Error processing prompt: ${error.message}`, error.stack);

            // Fallback to regex extraction in case of AI error
            const fallbackUrls = this.extractUrlsWithRegex(prompt);
            const rewrittenPrompt =
                fallbackUrls.length > 0
                    ? this.rewritePromptWithoutUrls(prompt, fallbackUrls)
                    : prompt;

            return {
                extractedUrls: fallbackUrls,
                suggestedCategories: [],
                priorityCategories: [],
                featuredItemHints: [],
                rewrittenPrompt,
            };
        }
    }

    /**
     * Backward compatibility method for extracting URLs from prompt
     * @param slug The slug for logging purposes
     * @param prompt The prompt to extract URLs from
     * @returns Object containing extracted URLs and rewritten prompt
     */
    async extractUrlsFromPrompt(
        slug: string,
        prompt: string,
    ): Promise<{
        extractedUrls: string[];
        rewrittenPrompt: string;
    }> {
        const result = await this.processPrompt(slug, prompt);
        return {
            extractedUrls: result.extractedUrls,
            rewrittenPrompt: result.rewrittenPrompt,
        };
    }

    /**
     * Extract URLs from text using regex
     * @param text The text to extract URLs from
     * @returns Array of extracted URLs
     */
    private extractUrlsWithRegex(text: string): string[] {
        if (!text) return [];

        // Regex to match URLs
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const matches = text.match(urlRegex);

        return this.validateUrls(matches || []);
    }

    /**
     * Rewrite prompt without URLs
     * @param prompt The original prompt
     * @param urls URLs to remove from the prompt
     * @returns Rewritten prompt
     */
    private rewritePromptWithoutUrls(prompt: string, urls: string[]): string {
        if (!prompt || urls.length === 0) return prompt;

        let rewritten = prompt;

        // Replace each URL with an empty string
        urls.forEach((url) => {
            rewritten = rewritten.replace(url, '');
        });

        // Clean up any double spaces or trailing/leading spaces
        rewritten = rewritten
            .replace(/\s+/g, ' ')
            .replace(/\s+\./g, '.')
            .replace(/\s+,/g, ',')
            .trim();

        return rewritten;
    }

    /**
     * Validate URLs to ensure they are properly formatted
     * @param urls Array of URLs to validate
     * @returns Array of valid URLs
     */
    private validateUrls(urls: string[]): string[] {
        if (!urls || urls.length === 0) return [];

        return urls.filter((url) => {
            try {
                // Check if URL is valid by creating a URL object
                new URL(url);
                return true;
            } catch (error) {
                this.logger.warn(`Invalid URL format: ${url}`);
                return false;
            }
        });
    }

    /**
     * Clean and normalize category suggestions
     * @param categories Array of category suggestions to clean
     * @returns Array of cleaned category names
     */
    private cleanCategories(categories: string[]): string[] {
        if (!categories || categories.length === 0) return [];

        return categories
            .filter(Boolean) // Remove empty strings
            .map((category) => category.trim()) // Trim whitespace
            .filter((category) => category.length > 0) // Remove empty after trim
            .map((category) => {
                // Normalize category names (capitalize first letter, remove extra spaces)
                return category
                    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                    .split(' ')
                    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                    .join(' ');
            })
            .filter((category, index, arr) => arr.indexOf(category) === index); // Remove duplicates
    }
}

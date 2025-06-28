import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService } from '../shared';
import { BaseChatModel } from '../shared/ai-provider.interface';

// Prompt processing prompt
const PROMPT_PROCESSING_PROMPT = `
You are a helpful assistant tasked with extracting URLs and explicitly mentioned categories from a user's prompt, then rewriting the prompt to focus only on the core task idea.

<rules>
1. Extract all URLs mentioned in the prompt.
2. Extract *only* categories that are explicitly mentioned in the prompt. (e.g "I want categories like Monitoring, CI/CD, and Testing")
3. Extract priority categories that should appear first in the final output based on priority indicators in the prompt.
4. Extract featured item specifications that indicate which types of items should be marked as featured/highlighted.
5. Rewrite the prompt to focus ONLY on the main task idea and important prompt instructions, removing ALL hints and specifications.
6. Return the extracted URLs, explicitly mentioned categories, priority categories, featured item hints, and the rewritten prompt.
</rules>

<url_extraction_guidelines>
### Guidelines for URL extraction:
- Only extract URLs that are explicitly mentioned in the prompt
- Do not infer or generate URLs that aren't directly mentioned
</url_extraction_guidelines>

<categories_extraction_guidelines>
### Guidelines for category extraction:
- Look for categories that are explicitly mentioned by the user as desired categories
- Extract categories mentioned in phrases like:
  * "categories like X, Y, Z"
  * "organize into categories: X, Y, Z"
  * "use categories such as X, Y, Z"
  * "categorize as X, Y, Z"
  * "group into X, Y, Z categories"
  * "with categories X, Y, Z"
- Extract specific item types when mentioned as intended categories (e.g., "monitoring tools", "CI/CD solutions", "testing frameworks")
- Extract domain-specific categories (e.g., "open-source projects", "enterprise software", "cloud services")
- Do NOT extract general descriptive terms that aren't meant as categories
- Do NOT extract categories that are just examples or context, only those the user wants to actually use
- Do not extract categories from a prompt similar to this (e.g "Generate a list of the best time tracking software for businesses and open source solutions."), here "businesses" and "open source" are not explicit categories.
- Focus on categories the user explicitly wants to be considered for organizing their directory

### Examples of what TO extract as categories:
- "I want categories like Monitoring, CI/CD, and Testing"
- "organize these tools into categories: Development, Design, Marketing"
- "categorize as open-source projects and commercial tools"

### Examples of what NOT to extract as categories:
- "I'm looking for various development tools" (too general, not explicit categories)
- "tools for monitoring and testing" (descriptive, not explicit category instruction)
- "similar to monitoring tools" (example/comparison, not explicit category)
</categories_extraction_guidelines>

<priority_categories_extraction_guidelines>
### Guidelines for priority category extraction:
- Look for categories that are explicitly mentioned with priority indicators
- Extract categories mentioned with priority phrases like:
  * "start with X category" or "begin with X"
  * "X should be first" or "X first"
  * "prioritize X" or "X is priority"
  * "most important is X" or "X is most important"
  * "focus on X first" or "X should come first"
  * "lead with X" or "X at the top"
  * "X should appear first" or "show X first"
- Extract categories mentioned in ordered lists where position indicates priority (e.g., "1. Open Source, 2. CI/CD")
- Extract categories that are emphasized as primary or main focus
- Do NOT extract all categories as priority - only those with clear priority indicators
- Priority categories should also be included in the regular suggestedCategories list

### Examples of what TO extract as priority categories:
- "Start with Open Source tools, then other categories"
- "Prioritize CI/CD solutions above all else"
- "Most important category is Monitoring"
- "1. Open Source, 2. Enterprise, 3. Others" (extract "Open Source" and "Enterprise" as priority)
- "Focus on Open Source projects first"

### Examples of what NOT to extract as priority categories:
- "I want categories like Monitoring, CI/CD, and Testing" (no priority indicators)
- "organize these tools into categories" (no specific priority mentioned)
- "categorize as open-source and commercial" (equal treatment, no priority)
</priority_categories_extraction_guidelines>

<featured_item_hints_extraction_guidelines>
### Guidelines for featured item extraction:
- Look for specifications about which items should be highlighted, featured, or given special prominence
- Extract featured item hints mentioned with phrases like:
  * "highlight X items" or "feature X tools"
  * "X should be featured" or "showcase X"
  * "emphasize X solutions" or "spotlight X"
  * "X are most important" or "key X items"
  * "top X tools" or "best X solutions"
  * "leading X platforms" or "premier X services"
  * "enterprise X" or "commercial X" (when context suggests prominence)
  * "popular X" or "widely used X"
  * "recommended X" or "preferred X"
- Extract company-specific items when mentioned (e.g., "include our company's tools", "feature our products")
- Extract specific item names that should be featured (e.g., "make sure to highlight Docker and Kubernetes")
- Extract item characteristics that indicate featuring (e.g., "feature open-source solutions", "highlight enterprise tools")
- Do NOT extract general descriptive terms that don't indicate special prominence
- Focus on specifications that clearly indicate certain items should stand out from others

### Examples of what TO extract as featured item hints:
- "Feature the top open-source monitoring tools"
- "Highlight enterprise solutions"
- "Showcase Docker and Kubernetes prominently"
- "Our company's products should be featured"
- "Emphasize the most popular CI/CD tools"
- "Spotlight leading cloud platforms"
- "Make sure to highlight recommended solutions"

### Examples of what NOT to extract as featured item hints:
- "I want monitoring tools" (no prominence indication)
- "include various development tools" (no special highlighting)
- "tools for testing and deployment" (descriptive, not prominence-focused)
</featured_item_hints_extraction_guidelines>

<prompt_rewriting_guidelines>
### Guidelines for prompt rewriting:
- Remove ALL URLs from the prompt
- Remove ALL category specifications and hints (e.g., "Be sure to include both open-source and commercial categories")
- Remove ALL priority indicators (e.g., "starting with open-source projects", "prioritizing commercial solutions")
- Remove ALL featured item specifications (e.g., "Please prioritize solutions Ever Cloc, Ever Teams, Ever Gauzy")
- Remove ALL reference instructions (e.g., "For reference, consult: https://...")
- Remove ALL categorization instructions (e.g., "When listing open-source projects, strictly use the license type as the tag")
- Separated prompt instructions should be combined into a single, coherent task description
- Preserve the essential context about what the user wants to accomplish with separated instructions combined
- The rewritten prompt should be clean, focused, and contain only the essential instructions without any processing hints, categorization instructions, priority specifications, or reference URLs.
</prompt_rewriting_guidelines>

<prompt>
{prompt}
</prompt>`;

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

    constructor(private readonly aiService: AiService) {
        this.llm = this.aiService.createLlmWithTemperature(0.0);
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

            const promptTemplate = HumanMessagePromptTemplate.fromTemplate(PROMPT_PROCESSING_PROMPT);
            const result = await promptTemplate
                .pipe(this.llm.withStructuredOutput(promptProcessingOutputSchema))
                .invoke({
                    prompt,
                });

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

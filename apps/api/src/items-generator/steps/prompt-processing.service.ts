import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService } from '../shared';

// Prompt processing prompt
const PROMPT_PROCESSING_PROMPT = `
You are a helpful assistant tasked with extracting URLs and category hints from a user's prompt, then rewriting the prompt without the URLs while preserving the context.

<prompt>
{prompt}
</prompt>

Your task:
1. Extract all URLs mentioned in the prompt.
2. Extract any category hints or suggestions mentioned in the prompt (e.g., "open-source projects", "monitoring tools", "CI/CD solutions", etc.).
3. Rewrite the prompt without the URLs but preserve the context and meaning.
4. Return the extracted URLs, suggested categories, and the rewritten prompt.

Only extract URLs that are explicitly mentioned in the prompt. Do not infer or generate URLs that aren't directly mentioned.
For categories, look for explicit mentions of types, categories, or classifications of items the user wants to find.
`.trim();

// Output schema for validation
const promptProcessingOutputSchema = z.object({
  extractedUrls: z
    .array(z.string())
    .describe('List of URLs extracted from the prompt'),
  suggestedCategories: z
    .array(z.string())
    .describe('List of category hints extracted from the prompt'),
  rewrittenPrompt: z
    .string()
    .describe('The prompt rewritten without URLs but preserving context'),
});

@Injectable()
export class PromptProcessingService {
  private readonly logger = new Logger(PromptProcessingService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.createLlmWithTemperature(0.1);
  }

  /**
   * Extract URLs and category hints from a prompt and rewrite the prompt without URLs
   * @param slug The slug for logging purposes
   * @param prompt The prompt to extract URLs and categories from
   * @returns Object containing extracted URLs, suggested categories, and rewritten prompt
   */
  async processPrompt(
    slug: string,
    prompt: string,
  ): Promise<{
    extractedUrls: string[];
    suggestedCategories: string[];
    rewrittenPrompt: string;
  }> {
    if (!prompt) {
      this.logger.warn(`[${slug}] No prompt provided for processing`);
      return { extractedUrls: [], suggestedCategories: [], rewrittenPrompt: prompt || '' };
    }

    // Use AI for sophisticated extraction of URLs and categories
    try {
      this.logger.log(`[${slug}] Using AI to process prompt for URLs and categories`);

      const promptTemplate = HumanMessagePromptTemplate.fromTemplate(
        PROMPT_PROCESSING_PROMPT,
      );
      const result = await promptTemplate
        .pipe(this.llm.withStructuredOutput(promptProcessingOutputSchema))
        .invoke({
          prompt,
        });

      const { extractedUrls, suggestedCategories, rewrittenPrompt } = result;

      this.logger.log(
        `[${slug}] AI extracted ${extractedUrls.length} URLs and ${suggestedCategories.length} category hints from prompt`,
      );

      const validatedUrls = this.validateUrls(extractedUrls);
      const cleanedCategories = this.cleanCategories(suggestedCategories);

      return {
        extractedUrls: validatedUrls,
        suggestedCategories: cleanedCategories,
        rewrittenPrompt:
          validatedUrls.length > 0 ? rewrittenPrompt || prompt : prompt,
      };
    } catch (error) {
      this.logger.error(
        `[${slug}] Error processing prompt: ${error.message}`,
        error.stack,
      );

      // Fallback to regex extraction in case of AI error
      const fallbackUrls = this.extractUrlsWithRegex(prompt);
      const rewrittenPrompt =
        fallbackUrls.length > 0
          ? this.rewritePromptWithoutUrls(prompt, fallbackUrls)
          : prompt;

      return {
        extractedUrls: fallbackUrls,
        suggestedCategories: [],
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

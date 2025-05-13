import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService } from '../shared';

// URL extraction prompt
const URL_EXTRACTION_PROMPT = `
You are a helpful assistant tasked with extracting URLs from a user's prompt and then rewriting the prompt without the URLs while preserving the context.

<prompt>
{prompt}
</prompt>

Your task:
1. Extract all URLs mentioned in the prompt.
2. Rewrite the prompt without the URLs but preserve the context and meaning.
3. Return both the extracted URLs and the rewritten prompt.

Only extract URLs that are explicitly mentioned in the prompt. Do not infer or generate URLs that aren't directly mentioned.
`.trim();

// Output schema for validation
const urlExtractionOutputSchema = z.object({
  extractedUrls: z
    .array(z.string())
    .describe('List of URLs extracted from the prompt'),
  rewrittenPrompt: z
    .string()
    .describe('The prompt rewritten without URLs but preserving context'),
});

@Injectable()
export class UrlExtractionService {
  private readonly logger = new Logger(UrlExtractionService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.createLlmWithTemperature(0.1);
  }

  /**
   * Extract URLs from a prompt and rewrite the prompt without URLs
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
    if (!prompt) {
      this.logger.warn(`[${slug}] No prompt provided for URL extraction`);
      return { extractedUrls: [], rewrittenPrompt: prompt || '' };
    }

    // If regex didn't find URLs, use AI for more sophisticated extraction
    try {
      this.logger.log(`[${slug}] Using AI to extract URLs from prompt`);

      const promptTemplate = HumanMessagePromptTemplate.fromTemplate(
        URL_EXTRACTION_PROMPT,
      );
      const result = await promptTemplate
        .pipe(this.llm.withStructuredOutput(urlExtractionOutputSchema))
        .invoke({
          prompt,
        });

      const { extractedUrls, rewrittenPrompt } = result;

      this.logger.log(
        `[${slug}] AI extracted ${extractedUrls.length} URLs from prompt`,
      );

      const validatedUrls = this.validateUrls(extractedUrls);

      return {
        extractedUrls: validatedUrls,
        rewrittenPrompt:
          validatedUrls.length > 0 ? rewrittenPrompt || prompt : prompt,
      };
    } catch (error) {
      this.logger.error(
        `[${slug}] Error extracting URLs from prompt: ${error.message}`,
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
        rewrittenPrompt,
      };
    }
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
}

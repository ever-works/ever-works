import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { ConfigDto } from '../dto/create-items-generator.dto';
import {
  WebPageData,
  RelevanceAssessment,
} from '../interfaces/items-generator.interfaces';
import { AiService } from '../shared';

@Injectable()
export class ContentFilteringService {
  private readonly logger = new Logger(ContentFilteringService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.getLlm();
  }

  async filterAndAssessPages(
    slug: string,
    webPages: WebPageData[],
    topicName: string,
    topicDescription: string,
    config: Required<ConfigDto>,
  ): Promise<WebPageData[]> {
    this.logger.log(
      `[${slug}] Starting content filtering for ${webPages.length} pages`,
    );

    const filteredPages = webPages.filter((page) => {
      const isLongEnough =
        page.raw_content.length >= config.min_content_length_for_extraction;

      return isLongEnough;
    });

    // Check if OpenAI API is configured
    if (!this.llm.apiKey) {
      return filteredPages;
    }

    this.logger.log(
      `[${slug}] ${filteredPages.length} pages passed initial length filter`,
    );

    if (filteredPages.length === 0) {
      return [];
    }

    // Define the relevance assessment function
    const assessPageRelevance = async (
      page: WebPageData,
    ): Promise<{
      page: WebPageData;
      isRelevant: boolean;
      assessment?: RelevanceAssessment;
      error?: any;
    }> => {
      try {
        this.logger.log(
          `[${slug}] Assessing relevance for: ${page.source_url}`,
        );

        // Using function calling for structured output
        const relevanceFunction = {
          name: 'assess_content_relevance',
          description:
            'Assess if the provided web page content is highly relevant to the given topic.',
          parameters: {
            type: 'object',
            properties: {
              relevant: {
                type: 'boolean',
                description:
                  'True if the content is highly relevant, false otherwise.',
              },
              relevance_score: {
                type: 'number',
                description:
                  'A score between 0.0 (not relevant) and 1.0 (highly relevant).',
              },
              reason: {
                type: 'string',
                description:
                  'A brief explanation for the relevance assessment.',
              },
            },
            required: ['relevant', 'relevance_score', 'reason'],
          },
        };

        // Stricter prompt for page relevance
        const prompt = PromptTemplate.fromTemplate(
          `You are an expert content analyst. Assess the relevance of the following web page content to the **main topic**: "{topicName}" (Description: "{topicDescription}").

Web Page Content (first 2000 characters):
---
{page_content_snippet}
---

**Critically evaluate:** Is this page's **primary focus** highly relevant to "{topicName}"?
- **Accept:** Pages dedicated to the topic, comprehensive comparisons, core tutorials, official documentation, key project pages.
- **Reject:** Pages where the topic is only mentioned briefly, listicles covering many unrelated topics, pages focused *only* on a very specific niche *unless* that niche is the explicit topic "{topicName}" (e.g., reject a page *only* about a Ruby vector library if the topic is general vector databases), forum threads with low signal-to-noise, or purely marketing pages.

Provide a relevance score between 0.0 (not relevant) and 1.0 (highly relevant). Only assign a high score if the primary focus aligns strongly with "{topicName}".
`,
        );

        const outputParser = new JsonOutputFunctionsParser();
        const relevanceChain = prompt
          .pipe(
            this.llm.bind({
              functions: [relevanceFunction],
              function_call: { name: 'assess_content_relevance' },
            }),
          )
          .pipe(outputParser);

        const assessmentResult = (await relevanceChain.invoke({
          topicName,
          topicDescription,
          page_content_snippet: page.raw_content.slice(0, 2000),
        })) as RelevanceAssessment;

        const isRelevant =
          assessmentResult.relevant &&
          assessmentResult.relevance_score >=
            config.relevance_threshold_content;

        if (isRelevant) {
          this.logger.log(
            `[${slug}] Relevant page (Score: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
          );
        } else {
          this.logger.log(
            `[${slug}] Discarding page (Not relevant/Score too low: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
          );
        }

        return { page, isRelevant, assessment: assessmentResult };
      } catch (error) {
        this.logger.error(
          `[${slug}] Error assessing relevance for ${page.source_url}: ${error.message}`,
          error.stack,
        );
        this.logger.warn(
          `[${slug}] Keeping page due to relevance assessment error (will rely on later extraction quality): ${page.source_url}`,
        );
        return { page, isRelevant: true, error };
      }
    };

    // Step 3: Process pages in batches to avoid rate limits
    const BATCH_SIZE = 10;
    const relevantPages: WebPageData[] = [];

    this.logger.log(
      `[${slug}] Processing relevance assessment in batches of ${BATCH_SIZE}`,
    );

    // Process pages in batches
    for (let i = 0; i < filteredPages.length; i += BATCH_SIZE) {
      const batch = filteredPages.slice(i, i + BATCH_SIZE);

      // Process the batch in parallel
      const assessmentPromises = batch.map((page) => assessPageRelevance(page));
      const assessmentResults = await Promise.all(assessmentPromises);

      // Filter relevant pages from this batch
      const relevantPagesFromBatch = assessmentResults
        .filter((result) => result.isRelevant)
        .map((result) => result.page);

      relevantPages.push(...relevantPagesFromBatch);

      // Add a small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < filteredPages.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    this.logger.log(
      `[${slug}] Content filtering complete. ${relevantPages.length} relevant pages found out of ${webPages.length} total pages.`,
    );
    return relevantPages;
  }
}

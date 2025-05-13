import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { ConfigDto } from '../dto/create-items-generator.dto';
import {
  WebPageData,
  RelevanceAssessment,
} from '../interfaces/items-generator.interfaces';

@Injectable()
export class ContentFilteringService {
  private readonly logger = new Logger(ContentFilteringService.name);
  private llm: ChatOpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      this.logger.warn(
        'OPENAI_API_KEY not found in .env file. AI features will be limited.',
      );
    }

    this.llm = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      modelName: process.env.OPENAI_MODEL || 'gpt-4.1',
      temperature: 0.7,
    });
  }

  async filterAndAssessPages(
    slug: string,
    webPages: WebPageData[],
    topicName: string,
    topicDescription: string,
    config: Required<ConfigDto>,
  ): Promise<WebPageData[]> {
    const relevantPages: WebPageData[] = [];
    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${slug}] OpenAI API Key not configured. Skipping LLM-based relevance assessment. Applying basic content length filter only.`,
      );
    }

    for (const page of webPages) {
      const textContent = page.raw_content;

      if (textContent.length < config.min_content_length_for_extraction) {
        this.logger.log(
          `[${slug}] Discarding page (too short: ${textContent.length} chars): ${page.source_url}`,
        );
        continue;
      }

      if (!this.llm.apiKey) {
        this.logger.log(
          `[${slug}] Keeping page (OpenAI API Key not configured, basic length check passed): ${page.source_url}`,
        );
        relevantPages.push(page);
        continue;
      }

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
          page_content_snippet: textContent.slice(0, 2000), // Send a snippet to save tokens/time
        })) as RelevanceAssessment;

        if (
          assessmentResult.relevant &&
          assessmentResult.relevance_score >= config.relevance_threshold_content
        ) {
          this.logger.log(
            `[${slug}] Relevant page (Score: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
          );
          relevantPages.push(page);
        } else {
          this.logger.log(
            `[${slug}] Discarding page (Not relevant/Score too low: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `[${slug}] Error assessing relevance for ${page.source_url}: ${error.message}`,
          error.stack,
        );
        this.logger.warn(
          `[${slug}] Keeping page due to relevance assessment error (will rely on later extraction quality): ${page.source_url}`,
        );
        relevantPages.push(page);
      }
    }
    return relevantPages;
  }
}

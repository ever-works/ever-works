import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { slugifyText } from '../utils/text.utils';
import { AiService } from '../shared';
import { ItemData } from '../dto';
import {
  extractedItemsSchema,
  itemDataSchema,
  promptUnderstandingAssessmentSchema,
} from '../schemas/item-extraction.schemas';

@Injectable()
export class AiItemGenerationService {
  private readonly logger = new Logger(AiItemGenerationService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.getLlm();
  }

  async generateInitialItemsWithAI(
    slug: string,
    topicName: string,
    topicDescription: string,
    targetKeywords: string[] | undefined,
  ): Promise<ItemData[]> {
    this.logger.log(
      `[${slug}] AI-First Item Generation - Starting for topic: ${topicName}`,
    );
    const allGeneratedItems: ItemData[] = [];

    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${slug}] OpenAI API Key not configured. Skipping AI-first item generation.`,
      );
      return [];
    }

    // 1. Assess Prompt Understanding
    const understandingAssessmentFunction = {
      name: 'assess_prompt_understanding_for_item_generation',
      description:
        'Assesses if the provided topic, description, and keywords are clear and specific enough to generate a meaningful list of items for an Directory Builder.',
      parameters: zodToJsonSchema(promptUnderstandingAssessmentSchema),
    };

    const understandingPrompt = PromptTemplate.fromTemplate(
      `You are an AI assistant helping to curate an "Directory Builder".
Topic: "{topicName}"
Description: "{topicDescription}"
Keywords: "{target_keywords_string}"

Before attempting to generate items, please assess if the provided information is clear, specific, and sufficient for you to generate a high-quality, relevant list of items (tools, resources, libraries, etc.).

- If the information is clear and sufficient, respond with 'can_proceed: true'.
- If the information is too vague, ambiguous, or lacks necessary detail, respond with 'can_proceed: false' and provide a brief 'reason_if_cannot_proceed'.
- Optionally, if 'can_proceed: false', you can provide 'suggested_clarifications' as an array of questions or points the user could address to improve the prompt.

Consider:
- Is the topic well-defined?
- Is the scope clear (not too broad, not too narrow without context)?
- Are there any ambiguities that would make item generation difficult or likely to produce irrelevant results?
`,
    );

    const understandingChain = understandingPrompt
      .pipe(
        this.llm.bind({
          functions: [understandingAssessmentFunction],
          function_call: {
            name: 'assess_prompt_understanding_for_item_generation',
          },
        }),
      )
      .pipe(new JsonOutputFunctionsParser());

    try {
      const assessment = (await understandingChain.invoke({
        topicName,
        topicDescription,
        target_keywords_string: targetKeywords
          ? targetKeywords.join(', ')
          : 'N/A',
      })) as {
        can_proceed: boolean;
        reason_if_cannot_proceed: string | null;
        suggested_clarifications?: string[];
      };

      if (!assessment.can_proceed) {
        this.logger.warn(
          `[${slug}] AI cannot confidently proceed with item generation for topic "${topicName}" due to prompt clarity. Reason: ${assessment.reason_if_cannot_proceed || 'No specific reason provided.'}`,
        );
        if (
          assessment.suggested_clarifications &&
          assessment.suggested_clarifications.length > 0
        ) {
          this.logger.warn(
            `[${slug}] AI suggested clarifications: ${assessment.suggested_clarifications.join('; ')}`,
          );
        }
        return []; // Do not proceed with item generation
      }

      this.logger.log(
        `[${slug}] AI assessment: Prompt for topic "${topicName}" is clear. Proceeding with item generation.`,
      );
    } catch (error) {
      this.logger.error(
        `[${slug}] Error during AI prompt understanding assessment for topic "${topicName}": ${error.message}. Proceeding with caution (will attempt item generation).`,
        error.stack,
      );
      // If the understanding check itself fails, we log the error but still attempt item generation.
      // This is a fallback in case the assessment mechanism has an issue.
    }

    // 2. Proceed with Item Generation if understanding is sufficient (or assessment failed)
    const itemGenerationFunction = {
      name: 'generate_awesome_list_items_directly',
      description:
        'Generates a list of distinct items (tools, resources, libraries, articles, etc.) that are highly relevant to the directory builder topic, including their details.',
      parameters: zodToJsonSchema(extractedItemsSchema),
    };

    const generationPrompt = PromptTemplate.fromTemplate(
      `You are an expert curator and technical writer tasked with generating an initial list of items for an "Directory Builder" about a specific topic.
The **main topic** of the Directory Builder is: "{topicName}"
Description: "{topicDescription}"
Optional initial keywords: {target_keywords_string}

Based on this topic, please generate a comprehensive list of distinct items (e.g., tools, software, libraries, frameworks, official documentation, key community resources, important projects).

For each item, provide the following details:
1.  **name**: The canonical name of the item.
2.  **description**: A concise description (1-3 sentences) highlighting its specific relevance to "{topicName}".
3.  **source_url**: The most direct and canonical URL (e.g., homepage, official documentation, repository). If a high-quality, canonical URL cannot be confidently determined, you may omit it but it's highly encouraged.

**Critical Instructions:**
-   Focus on **relevance** to "{topicName}".
-   Aim for **diversity** in the types of items if appropriate for the topic.
-   Provide **accurate and canonical** information, especially for names and URLs.
-   If the topic is broad, try to cover its main sub-areas. If it's niche, focus on key resources for that niche.

Generate the list of items according to the specified schema.
`,
    );

    // Use a lower temperature for item generation
    const lowTempLlm = this.aiService.createLlmWithTemperature(0.2);

    const generationChain = generationPrompt
      .pipe(
        lowTempLlm.bind({
          functions: [itemGenerationFunction],
          function_call: { name: 'generate_awesome_list_items_directly' },
        }),
      )
      .pipe(new JsonOutputFunctionsParser());

    try {
      const result = (await generationChain.invoke({
        topicName,
        topicDescription,
        target_keywords_string: targetKeywords
          ? targetKeywords.join(', ')
          : 'N/A',
      })) as { items?: Partial<ItemData>[] };

      if (result && result.items && result.items.length > 0) {
        this.logger.log(
          `[${slug}] AI initially generated ${result.items.length} items.`,
        );
        for (const generatedItem of result.items) {
          try {
            const itemToValidate: Partial<ItemData> = {
              ...generatedItem,
            };

            const validatedItem = itemDataSchema.parse(
              itemToValidate,
            ) as ItemData;

            validatedItem.slug = slugifyText(validatedItem.name);

            if (!validatedItem.source_url) {
              this.logger.warn(
                `[${slug}] AI generated item "${validatedItem.name}" without a source_url. Deduplication might be affected.`,
              );
            }
            allGeneratedItems.push(validatedItem);
          } catch (validationError) {
            this.logger.warn(
              `[${slug}] Discarding AI-generated item due to validation error: ${validationError.errors.map((e: any) => e.message).join(', ')}. Item: ${JSON.stringify(generatedItem)}`,
            );
          }
        }
      } else {
        this.logger.log(
          `[${slug}] No initial items generated by AI for topic: ${topicName}.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[${slug}] Error generating initial items with AI for topic ${topicName}: ${error.message}`,
        error.stack,
      );
    }

    this.logger.log(
      `[${slug}] AI-First Item Generation - Complete. Validated ${allGeneratedItems.length} items.`,
    );
    return allGeneratedItems;
  }
}

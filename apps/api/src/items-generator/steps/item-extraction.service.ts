import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { extractedItemsSchema, itemDataSchema } from '../../agent/schemas';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { slugifyText } from '../utils/text.utils';
import { AiService } from '../shared';
import { ItemData } from '../dto';

@Injectable()
export class ItemExtractionService {
  private readonly logger = new Logger(ItemExtractionService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.getLlm();
  }

  async extractItemsFromPages(
    slug: string,
    relevantPages: WebPageData[],
    topicName: string,
    topicDescription: string,
    config: Required<ConfigDto>,
  ): Promise<ItemData[]> {
    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${slug}] OpenAI API Key not configured. Skipping AI-driven item extraction.`,
      );
      return [];
    }

    // Filter pages with sufficient content
    const pagesWithSufficientContent = relevantPages.filter((page) => {
      const hasSufficientContent =
        page.raw_content &&
        page.raw_content.length >= config.min_content_length_for_extraction;

      if (!hasSufficientContent) {
        this.logger.log(
          `[${slug}] Skipping item extraction for page (insufficient content): ${page.source_url}`,
        );
      }

      return hasSufficientContent;
    });

    if (pagesWithSufficientContent.length === 0) {
      return [];
    }

    // Define the item extraction function
    const extractItemsFromPage = async (
      page: WebPageData,
    ): Promise<ItemData[]> => {
      const extractedItems: ItemData[] = [];

      try {
        const itemExtractionFunction = {
          name: 'extract_awesome_list_items',
          description:
            'Extracts one or more distinct items (tools, resources, libraries, articles, etc.) from the provided web page content that are relevant to the directory builder topic, including generating relevant Markdown content.',
          parameters: zodToJsonSchema(extractedItemsSchema),
        };

        // Stricter prompt for item extraction
        const prompt = PromptTemplate.fromTemplate(
          `You are an expert data extractor and technical writer for "Directory Builder" directories.
The **main topic** of the Directory Builder is: "{topicName}" (Description: "{topicDescription}").
From the following web page content, identify and extract information for one or more distinct items (tools, resources, libraries, articles, etc.) that are **directly and highly relevant to this main topic**. Do NOT extract items that are only tangentially related or represent a different category unless it's explicitly part of "{topicName}".

Web Page Content:
---
{page_content_snippet}
---

For each identified item **that directly relates to "{topicName}"**:
1.  Provide its canonical **name**.
2.  Write a concise and short **description** highlighting its specific relevance to "{topicName}".
3.  Determine its most direct and canonical **source_url** (homepage, docs, repo etc.). Do not use URLs for blog posts merely mentioning the item unless the post *is* the primary resource. The URL must be valid and specific to the item.

**Critical Filter:** Only extract items that are *directly* relevant to the main topic "{topicName}". For example, if the topic is "Vector Databases", do not extract a general-purpose database or a library for a specific programming language (like Ruby) unless it's explicitly a vector database client/tool directly supporting the core topic. Ensure the \`source_url\` is for the item itself, not an article *about* the item.
Only call the extraction function if you find at least one item meeting these strict criteria.
`,
        );

        const outputParser = new JsonOutputFunctionsParser();
        const extractionChain = prompt
          .pipe(
            this.llm.bind({
              functions: [itemExtractionFunction],
              function_call: { name: 'extract_awesome_list_items' },
            }),
          )
          .pipe(outputParser);

        const extractionResult = (await extractionChain.invoke({
          topicName,
          topicDescription,
          page_content_snippet: page.raw_content,
        })) as { items?: Partial<ItemData>[] };

        if (
          extractionResult &&
          extractionResult.items &&
          extractionResult.items.length > 0
        ) {
          this.logger.log(
            `[${slug}] Found ${extractionResult.items.length} potential items in ${page.source_url}`,
          );

          // Process and validate each extracted item
          for (const extractedItem of extractionResult.items) {
            try {
              const validatedItem = itemDataSchema.parse(
                extractedItem,
              ) as ItemData;

              // Auto-generate slug if not provided or to ensure consistency
              validatedItem.slug = slugifyText(validatedItem.name);

              extractedItems.push(validatedItem);
              this.logger.log(
                `[${slug}] Extracted item: "${validatedItem.name}" (Slug: ${validatedItem.slug})`,
              );
            } catch (validationError) {
              this.logger.warn(
                `[${slug}] Discarding item due to validation error: ${validationError.errors.map((e: any) => e.message).join(', ')}. Item: ${JSON.stringify(extractedItem)} from ${page.source_url}`,
              );
            }
          }
        } else {
          this.logger.log(
            `[${slug}] No items extracted by LLM from ${page.source_url}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `[${slug}] Error extracting items from ${page.source_url}: ${error.message}`,
          error.stack,
        );
      }

      return extractedItems;
    };

    // Process pages in batches to avoid rate limits
    const BATCH_SIZE = 10;
    const allExtractedItems: ItemData[] = [];

    this.logger.log(
      `[${slug}] Processing item extraction in batches of ${BATCH_SIZE}`,
    );

    // Process pages in batches
    for (let i = 0; i < pagesWithSufficientContent.length; i += BATCH_SIZE) {
      const batch = pagesWithSufficientContent.slice(i, i + BATCH_SIZE);

      // Process the batch in parallel
      const extractionPromises = batch.map((page) =>
        extractItemsFromPage(page),
      );
      const batchResults = await Promise.all(extractionPromises);

      // Flatten the results and add to the main collection
      const extractedItemsFromBatch = batchResults.flat();
      allExtractedItems.push(...extractedItemsFromBatch);

      // Add a small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < pagesWithSufficientContent.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    this.logger.log(
      `[${slug}] Item extraction complete. Extracted ${allExtractedItems.length} items from ${pagesWithSufficientContent.length} pages.`,
    );
    return allExtractedItems;
  }
}

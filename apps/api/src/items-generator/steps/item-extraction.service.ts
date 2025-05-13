import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { extractedItemsSchema, itemDataSchema } from '../../agent/schemas';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { ItemData } from '../../agent/types';
import { slugifyText } from '../utils/text.utils';

@Injectable()
export class ItemExtractionService {
  private readonly logger = new Logger(ItemExtractionService.name);
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

  async extractItemsFromPages(
    slug: string,
    relevantPages: WebPageData[],
    topicName: string,
    topicDescription: string,
    config: Required<ConfigDto>,
  ): Promise<ItemData[]> {
    const allExtractedItems: ItemData[] = [];

    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${slug}] OpenAI API Key not configured. Skipping AI-driven item extraction.`,
      );
      return [];
    }

    const itemExtractionFunction = {
      name: 'extract_awesome_list_items',
      description:
        'Extracts one or more distinct items (tools, resources, libraries, articles, etc.) from the provided web page content that are relevant to the directory builder topic, including generating relevant Markdown content.',
      parameters: zodToJsonSchema(extractedItemsSchema),
    };

    for (const page of relevantPages) {
      if (
        !page.raw_content ||
        page.raw_content.length < config.min_content_length_for_extraction
      ) {
        this.logger.log(
          `[${slug}] Skipping item extraction for page (insufficient content): ${page.source_url}`,
        );
        continue;
      }

      this.logger.log(`[${slug}] Extracting items from: ${page.source_url}`);
      try {
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
2.  Write a concise **description** highlighting its specific relevance to "{topicName}".
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
          for (const extractedItem of extractionResult.items) {
            // Validate with Zod before pushing
            try {
              // Ensure all required fields are present before parsing, especially if LLM omits optionals
              const itemToValidate: Partial<ItemData> = {
                ...extractedItem,
              };

              const validatedItem = itemDataSchema.parse(
                itemToValidate,
              ) as ItemData;

              // Auto-generate slug if not provided or to ensure consistency
              validatedItem.slug = slugifyText(validatedItem.name);

              allExtractedItems.push(validatedItem);
              this.logger.log(
                `[${slug}] Extracted item: "${validatedItem.name}" (Slug: ${validatedItem.slug})`,
              );
            } catch (validationError) {
              this.logger.warn(
                `[${slug}] Discarding item due to validation error: ${validationError.errors.map((e) => e.message).join(', ')}. Item: ${JSON.stringify(extractedItem)} from ${page.source_url}`,
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
    }

    return allExtractedItems;
  }
}

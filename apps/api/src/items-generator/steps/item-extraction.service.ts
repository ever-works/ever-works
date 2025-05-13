import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { slugifyText } from '../utils/text.utils';
import { AiService } from '../shared';
import { ItemData } from '../dto';
import {
  extractedItemsSchema,
  itemDataSchema,
} from '../schemas/item-extraction.schemas';

@Injectable()
export class ItemExtractionService {
  private readonly logger = new Logger(ItemExtractionService.name);
  private llm: ChatOpenAI;
  private textSplitter: RecursiveCharacterTextSplitter;

  // Constants for content chunking
  private readonly MAX_CHUNK_SIZE = 8000; // Characters per chunk
  private readonly CHUNK_OVERLAP = 200; // Overlap between chunks

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.getLlm();
    this.textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.MAX_CHUNK_SIZE,
      chunkOverlap: this.CHUNK_OVERLAP,
    });
  }

  /**
   * Deduplicate items based on name similarity
   * @param items Array of items to deduplicate
   * @returns Deduplicated array of items
   */
  private deduplicateItems(items: ItemData[]): ItemData[] {
    if (!items || items.length <= 1) {
      return items;
    }

    // Use a Map to deduplicate by name (case-insensitive)
    const uniqueItems = new Map<string, ItemData>();

    for (const item of items) {
      const normalizedName = item.name.toLowerCase().trim();

      // If we haven't seen this name before, or if this item has a source_url and the existing one doesn't
      if (
        !uniqueItems.has(normalizedName) ||
        (!uniqueItems.get(normalizedName)?.source_url && item.source_url)
      ) {
        uniqueItems.set(normalizedName, item);
      }
    }

    return Array.from(uniqueItems.values());
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

        // Check if content is large enough to require chunking
        if (page.raw_content && page.raw_content.length > this.MAX_CHUNK_SIZE) {
          this.logger.log(
            `[${slug}] Content size (${page.raw_content.length} chars) exceeds chunk size limit. Processing in chunks for ${page.source_url}`,
          );

          // Split the content into chunks
          const chunks = await this.textSplitter.splitText(page.raw_content);
          this.logger.log(
            `[${slug}] Split content into ${chunks.length} chunks for processing from ${page.source_url}`,
          );

          // Process each chunk
          const chunkResults = await Promise.all(
            chunks.map(async (chunk: string, index: number) => {
              try {
                this.logger.log(
                  `[${slug}] Processing chunk ${index + 1}/${chunks.length} (${chunk.length} chars) from ${page.source_url}`,
                );

                const chunkResult = (await extractionChain.invoke({
                  topicName,
                  topicDescription,
                  page_content_snippet: chunk,
                })) as { items?: Partial<ItemData>[] };

                return chunkResult?.items || [];
              } catch (chunkError: any) {
                this.logger.error(
                  `[${slug}] Error processing chunk ${index + 1} from ${page.source_url}: ${chunkError.message}`,
                );
                return [];
              }
            }),
          );

          // Combine all items from all chunks
          const allExtractedItems = chunkResults.flat();

          if (allExtractedItems.length > 0) {
            this.logger.log(
              `[${slug}] Found ${allExtractedItems.length} potential items across ${chunks.length} chunks in ${page.source_url}`,
            );

            // Process and validate each extracted item
            const validatedItems: ItemData[] = [];
            for (const extractedItem of allExtractedItems) {
              try {
                const validatedItem = itemDataSchema.parse(
                  extractedItem,
                ) as ItemData;

                // Auto-generate slug if not provided or to ensure consistency
                validatedItem.slug = slugifyText(validatedItem.name);

                validatedItems.push(validatedItem);
                this.logger.log(
                  `[${slug}] Extracted item: "${validatedItem.name}" (Slug: ${validatedItem.slug})`,
                );
              } catch (validationError) {
                this.logger.warn(
                  `[${slug}] Discarding item due to validation error: ${validationError.errors.map((e: any) => e.message).join(', ')}. Item: ${JSON.stringify(extractedItem)} from ${page.source_url}`,
                );
              }
            }

            // Deduplicate items from different chunks
            const uniqueItems = this.deduplicateItems(validatedItems);
            if (uniqueItems.length < validatedItems.length) {
              this.logger.log(
                `[${slug}] Deduplicated ${validatedItems.length - uniqueItems.length} duplicate items from chunks in ${page.source_url}`,
              );
            }

            // Add unique items to the result
            extractedItems.push(...uniqueItems);
          } else {
            this.logger.log(
              `[${slug}] No items extracted by LLM from any chunks in ${page.source_url}`,
            );
          }
        } else {
          // Process the entire content at once for smaller pages
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
            const validatedItems: ItemData[] = [];
            for (const extractedItem of extractionResult.items) {
              try {
                const validatedItem = itemDataSchema.parse(
                  extractedItem,
                ) as ItemData;

                // Auto-generate slug if not provided or to ensure consistency
                validatedItem.slug = slugifyText(validatedItem.name);

                validatedItems.push(validatedItem);
                this.logger.log(
                  `[${slug}] Extracted item: "${validatedItem.name}" (Slug: ${validatedItem.slug})`,
                );
              } catch (validationError) {
                this.logger.warn(
                  `[${slug}] Discarding item due to validation error: ${validationError.errors.map((e: any) => e.message).join(', ')}. Item: ${JSON.stringify(extractedItem)} from ${page.source_url}`,
                );
              }
            }

            // Add validated items to the result
            extractedItems.push(...validatedItems);
          } else {
            this.logger.log(
              `[${slug}] No items extracted by LLM from ${page.source_url}`,
            );
          }
        }
      } catch (error: any) {
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

    // Final deduplication across all pages
    const uniqueExtractedItems = this.deduplicateItems(allExtractedItems);

    if (uniqueExtractedItems.length < allExtractedItems.length) {
      this.logger.log(
        `[${slug}] Deduplicated ${allExtractedItems.length - uniqueExtractedItems.length} duplicate items across all pages.`,
      );
    }

    this.logger.log(
      `[${slug}] Item extraction complete. Extracted ${uniqueExtractedItems.length} unique items from ${pagesWithSufficientContent.length} pages.`,
    );
    return uniqueExtractedItems;
  }
}

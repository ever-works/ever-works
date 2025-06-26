import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ConfigDto, CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { slugifyText } from '../utils/text.utils';
import { AiService } from '../shared';
import { ItemData } from '../dto';
import { extractedItemsSchema, itemDataSchema } from '../schemas/item-extraction.schemas';
import { BaseChatModel } from '../shared/ai-provider.interface';

const ITEMS_EXTRACTION_PROMPT =
    `You are an expert data extractor and technical writer for directory websites.
Your task is to identify and extract information for one or more distinct items (tools, resources, libraries, articles, etc.) that are **directly and highly relevant to this main topic**.

The **main topic** of this directory is: 
- topic name: "{topicName}" 
- topic task: "{topicDescription}".

---
**Featured Item Specifications:**
{featured_hints_section}
---

**RESEARCH CONTEXT INSTRUCTIONS:**
Below is the research context, including content extracted from the referenced web page. 
Please ensure that all relevant information and items from the research data are included. 
Exclude any invalid or irrelevant content, and align the findings with the topic and objectives of the task.

**EXTRACTION CRITERIA:**
- Only extract items that are *directly* relevant to the main topic "{topicName}" and topic task.
- Do NOT extract items that are only tangentially related or represent a different category unless it's explicitly part of "{topicName}" and topic task.
- Ignore items that has blog posts, news articles, or marketing pages as the item source_url, unless the user specifically requests them for their topic task
- Avoid using blog posts, news articles, or marketing pages as the source_url or item unless the user specifically requests them for their topic task (e.g 'Best Time Tracking Software for Small Businesses', 'Best Time Tracking Tools for Remote Teams', etc.).
- For example, if the topic is "Vector Databases", do not extract a general-purpose database or a library for a specific programming language (like Ruby) unless it's explicitly a vector database client/tool directly supporting the core topic
- Ensure the source_url is for the item itself, not an article *about* the item
- Featured items are those that match the specifications provided in the "Featured Item Specifications" section above.
- Do not use URLs for blog posts merely mentioning the item unless the post *is* the primary resource

<content>
{page_content_snippet}
<content>`.trim();

@Injectable()
export class ItemExtractionService {
    private readonly logger = new Logger(ItemExtractionService.name);
    private llm: BaseChatModel;
    private textSplitter: RecursiveCharacterTextSplitter;

    // Constants for content chunking
    private readonly MAX_CHUNK_SIZE = 3000; // Characters per chunk
    private readonly CHUNK_OVERLAP = 200; // Overlap between chunks

    constructor(private readonly aiService: AiService) {
        this.llm = this.aiService.createLlmWithTemperature(0.1);

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
            const existingItem = uniqueItems.get(normalizedName);

            if (
                !uniqueItems.has(normalizedName) ||
                (!existingItem?.source_url && item.source_url) ||
                (existingItem?.source_url &&
                    item.source_url &&
                    existingItem?.source_url.length > item.source_url.length)
            ) {
                uniqueItems.set(normalizedName, item);
            }
        }

        return Array.from(uniqueItems.values());
    }

    async extractItemsFromPages(
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        relevantPages: WebPageData[],
        featuredItemHints: string[] = [],
    ): Promise<ItemData[]> {
        const { slug, name: topicName, prompt: topicDescription, config } = createItemsGeneratorDto;

        if (!this.aiService.isAiConfigured()) {
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

        // Generate featured hints section for the prompt
        const featuredHintsSection = this.generateFeaturedHintsSection(featuredItemHints);

        // Define the item extraction function
        const extractItemsFromPage = async (page: WebPageData): Promise<ItemData[]> => {
            const extractedItems: ItemData[] = [];

            try {
                // Stricter prompt for item extraction
                const promptTemplate = HumanMessagePromptTemplate.fromTemplate(ITEMS_EXTRACTION_PROMPT);

                const extractionChain = promptTemplate.pipe(
                    this.llm.withStructuredOutput(extractedItemsSchema),
                );
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
                                    topicName: topicName,
                                    topicDescription: topicDescription,
                                    page_content_snippet: chunk,
                                    featured_hints_section: featuredHintsSection,
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
                        topicName: topicName,
                        topicDescription: topicDescription,
                        page_content_snippet: page.raw_content,
                        featured_hints_section: featuredHintsSection,
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

        this.logger.log(`[${slug}] Processing item extraction in batches of ${BATCH_SIZE}`);

        // Process pages in batches
        for (let i = 0; i < pagesWithSufficientContent.length; i += BATCH_SIZE) {
            const batch = pagesWithSufficientContent.slice(i, i + BATCH_SIZE);

            // Process the batch in parallel
            const extractionPromises = batch.map((page) => extractItemsFromPage(page));
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

    /**
     * Generate the featured hints section for the prompt
     * @param featuredItemHints Array of featured item specifications (guidelines, instructions, or criteria)
     * @returns Formatted section for the prompt
     */
    private generateFeaturedHintsSection(featuredItemHints: string[]): string {
        if (!featuredItemHints || featuredItemHints.length === 0) {
            return '';
        }

        return `
**Featured Item Specifications:**
The user has provided the following specifications for which items should be marked as featured (highlighted):
${featuredItemHints.map((hint) => `- ${hint}`).join('\n')}

When determining the 'featured' status for items, carefully consider these specifications. Items that match these criteria, guidelines, or instructions should be marked as featured=true.`;
    }
}

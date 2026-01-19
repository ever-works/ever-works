import { Injectable, Logger } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { slugifyText } from '../utils/text.utils';
import { AiService, TaskComplexity } from 'src/ai';
import { ItemData } from '../dto';
import {
    extractedItemsSchema,
    extractedItemsSchemaWithTags,
    itemDataSchema,
    itemDataWithCategoriesAndTagsSchema,
} from '../schemas/item-extraction.schemas';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { accumulateMetrics, MetricsAccumulator } from '../utils/metrics.util';
import { getErrorMessage, getErrorStack } from '../utils/error.util';
import { appendCustomPrompt } from '../utils/prompt.util';

const ITEMS_EXTRACTION_PROMPT =
    `You are an expert data extractor and technical writer for directory websites.
Your task is to identify and extract information for one or more distinct items (tools, resources, libraries, articles, etc.) 
that are **directly and highly relevant to the main topic and research context** and should match extraction criteria.

The **main topic** of this directory is: 
- topic name: "{topicName}" 
- topic task: "{topicDescription}".

<featured_item_hints_section>
**Featured Item Specifications:**
{featured_hints_section}
</featured_item_hints_section>

<research_context_instructions>
**RESEARCH CONTEXT INSTRUCTIONS:**
Below is the research context, including content extracted from the referenced web page. 
Please ensure that all relevant information and items from the research data are included. 
Exclude any invalid or irrelevant content, and align the findings with the topic and objectives of the task.
</research_context_instructions>

<extraction_criteria>
**EXTRACTION CRITERIA:**
- Only extract items that are *directly* relevant to the main topic "{topicName}" and topic task.
- Do NOT extract items that are only tangentially related or represent a different category unless it's explicitly part of "{topicName}" and topic task.
- Ignore items that has blog posts, news articles, or marketing pages as the item source_url, unless the user specifically requests them for their topic task
- For example, if the topic is "Vector Databases", do not extract a general-purpose database or a library for a specific programming language (like Ruby) unless it's explicitly a vector database client/tool directly supporting the core topic
- Ensure the source_url is for the item itself, not an article *about* the item
- Featured items are those that match the specifications provided in the "Featured Item Specifications" section above.
- Do not use URLs for blog posts merely mentioning the item unless the post *is* the primary resource
- Each item can have at most ONE brand; include it when the item clearly belongs to a product line/company and set brand_logo_url when a canonical logo is available.
- Provide multiple high-quality image URLs (screenshots, product imagery) when present on the source; prefer official domains and skip low-quality or unrelated images.
</extraction_criteria>

<web_page_content>
{page_content_snippet}
</web_page_content>` as const;

@Injectable()
export class ItemExtractionService implements IPipelineStep {
    private readonly logger = new Logger(ItemExtractionService.name);
    private textSplitter: RecursiveCharacterTextSplitter;

    // Constants for content chunking
    private readonly MAX_CHUNK_SIZE = 6000; // Characters per chunk
    private readonly CHUNK_OVERLAP = 200; // Overlap between chunks

    public readonly name = ItemsGeneratorStep.ITEMS_EXTRACTION;

    constructor(private readonly aiService: AiService) {
        this.textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.MAX_CHUNK_SIZE,
            chunkOverlap: this.CHUNK_OVERLAP,
            separators: ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ', ''],
        });
    }

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, webPages, featuredItemHints, metrics, advancedPrompts } = context;

        this.logger.log(
            `[${directory.slug}] AI-Driven Structured Data Extraction for Items from Web - Starting`,
        );

        const extractedWebItems: ItemData[] = await this.extractItemsFromPages(
            directory.slug,
            dto,
            webPages,
            featuredItemHints,
            false,
            metrics,
            advancedPrompts?.itemExtraction,
        );

        this.logger.log(
            `[${directory.slug}] Extracted ${extractedWebItems.length} potential items from web pages.`,
        );

        context.extractedWebItems = extractedWebItems;

        return context;
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
        directorySlug: string,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        relevantPages: WebPageData[],
        featuredItemHints: string[] = [],
        withTags = false,
        metrics?: MetricsAccumulator,
        customPrompt?: string | null,
    ): Promise<ItemData[]> {
        const { name: topicName, prompt: topicDescription, config } = createItemsGeneratorDto;

        if (!this.aiService.isAiConfigured()) {
            this.logger.warn(
                `[${directorySlug}] OpenAI API Key not configured. Skipping AI-driven item extraction.`,
            );
            return [];
        }

        // Filter pages with sufficient content
        const pagesWithSufficientContent = relevantPages.filter((page) => {
            const hasSufficientContent =
                page.raw_content &&
                page.raw_content.length >= config.min_content_length_for_extraction;

            if (!hasSufficientContent) {
                this.logger.debug(
                    `[${directorySlug}] Skipping item extraction for page (insufficient content): ${page.source_url}`,
                );
            }

            return hasSufficientContent;
        });

        if (pagesWithSufficientContent.length === 0) {
            return [];
        }

        // Generate featured hints section for the prompt
        const featuredHintsSection = this.generateFeaturedHintsSection(featuredItemHints);
        const schema = withTags ? extractedItemsSchemaWithTags : extractedItemsSchema;
        const validationSchema = withTags ? itemDataWithCategoriesAndTagsSchema : itemDataSchema;
        const finalPrompt = appendCustomPrompt(ITEMS_EXTRACTION_PROMPT, customPrompt);

        // Define the item extraction function
        const extractItemsFromPage = async (page: WebPageData): Promise<ItemData[]> => {
            const extractedItems: ItemData[] = [];

            try {
                // Check if content is large enough to require chunking
                if (page.raw_content && page.raw_content.length > this.MAX_CHUNK_SIZE) {
                    // Split the content into chunks
                    const chunks = await this.textSplitter.splitText(page.raw_content);

                    // Process each chunk
                    const chunkResults = await Promise.all(
                        chunks.map(async (chunk: string, index: number) => {
                            try {
                                const { result, usage, cost } = await this.aiService.askJson(
                                    finalPrompt,
                                    schema,
                                    {
                                        temperature: 0.1,
                                        variables: {
                                            topicName,
                                            topicDescription,
                                            page_content_snippet: chunk,
                                            featured_hints_section: featuredHintsSection,
                                        },
                                        routing: {
                                            complexity: TaskComplexity.COMPLEX,
                                            taskId: 'item-extraction-chunk',
                                        },
                                    },
                                );

                                accumulateMetrics(metrics, usage, cost);
                                return result?.items || [];
                            } catch (chunkError) {
                                this.logger.error(
                                    `[${directorySlug}] Error processing chunk ${index + 1} from ${page.source_url}: ${getErrorMessage(chunkError)}`,
                                );
                                return [];
                            }
                        }),
                    );

                    // Combine all items from all chunks
                    const allExtractedItems = chunkResults.flat();

                    if (allExtractedItems.length > 0) {
                        // Process and validate each extracted item
                        const validatedItems: ItemData[] = [];
                        for (const extractedItem of allExtractedItems) {
                            try {
                                const validatedItem = validationSchema.parse(
                                    extractedItem,
                                ) as ItemData;

                                // Auto-generate slug if not provided or to ensure consistency
                                validatedItem.slug = slugifyText(validatedItem.name);

                                validatedItems.push(validatedItem);
                            } catch {
                                // Skip invalid items silently
                            }
                        }

                        // Deduplicate items from different chunks
                        const uniqueItems = this.deduplicateItems(validatedItems);

                        // Add unique items to the result
                        extractedItems.push(...uniqueItems);
                    } else {
                        this.logger.debug(
                            `[${directorySlug}] No items extracted by LLM from any chunks in ${page.source_url}`,
                        );
                    }
                } else {
                    // Process the entire content at once for smaller pages
                    const {
                        result: extractionResult,
                        usage,
                        cost,
                    } = await this.aiService.askJson(finalPrompt, schema, {
                        temperature: 0.1,
                        variables: {
                            topicName,
                            topicDescription,
                            page_content_snippet: page.raw_content || '',
                            featured_hints_section: featuredHintsSection,
                        },
                        routing: {
                            complexity: TaskComplexity.COMPLEX,
                            taskId: 'item-extraction',
                        },
                    });

                    accumulateMetrics(metrics, usage, cost);

                    if (
                        extractionResult &&
                        extractionResult.items &&
                        extractionResult.items.length > 0
                    ) {
                        // Process and validate each extracted item
                        const validatedItems: ItemData[] = [];
                        for (const extractedItem of extractionResult.items) {
                            try {
                                const validatedItem = validationSchema.parse(
                                    extractedItem,
                                ) as ItemData;

                                // Auto-generate slug if not provided or to ensure consistency
                                validatedItem.slug = slugifyText(validatedItem.name);

                                validatedItems.push(validatedItem);
                            } catch {
                                // Skip invalid items silently
                            }
                        }

                        // Add validated items to the result
                        extractedItems.push(...validatedItems);
                    } else {
                        this.logger.debug(
                            `[${directorySlug}] No items extracted by LLM from ${page.source_url}`,
                        );
                    }
                }
            } catch (error) {
                this.logger.error(
                    `[${directorySlug}] Error extracting items from ${page.source_url}: ${getErrorMessage(error)}`,
                    getErrorStack(error),
                );
            }

            return extractedItems;
        };

        // Process pages in batches to avoid rate limits
        const BATCH_SIZE = 10;
        const allExtractedItems: ItemData[] = [];

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
                `[${directorySlug}] Deduplicated ${allExtractedItems.length - uniqueExtractedItems.length} duplicate items across all pages.`,
            );
        }

        this.logger.log(
            `[${directorySlug}] Item extraction complete. Extracted ${uniqueExtractedItems.length} unique items from ${pagesWithSufficientContent.length} pages.`,
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

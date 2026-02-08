import { z } from 'zod';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	WebPageData,
	MutableItemData,
	FacadeOptions
} from '@ever-works/plugin';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { slugifyText } from '../utils/text.utils.js';
import { getErrorStack } from '../utils/error.utils.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';
import {
	extractedItemsSchema,
	extractedItemsSchemaWithTags,
	itemDataSchema,
	itemDataWithCategoriesAndTagsSchema
} from '../schemas/item-extraction.schemas.js';

// Inferred types from schemas
type ExtractedItems = z.infer<typeof extractedItemsSchema>;
type ExtractedItemsWithTags = z.infer<typeof extractedItemsSchemaWithTags>;

const ITEMS_EXTRACTION_PROMPT = `You are an expert data extractor and technical writer for directory websites.
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

/**
 * Item Extraction Step
 *
 * Extracts items from web pages using AI.
 */
export class ItemExtractionStep extends BasePipelineStep {
	readonly stepId = 'items-extraction' as const;
	readonly name = 'Item Extraction';

	// Constants for content chunking
	private readonly MAX_CHUNK_SIZE = 6000;
	private readonly CHUNK_OVERLAP = 200;
	private readonly BATCH_SIZE = 10;

	private readonly textSplitter = new RecursiveCharacterTextSplitter({
		chunkSize: 6000,
		chunkOverlap: 200,
		separators: ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ', '']
	});

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, webPages, featuredItemHints, metrics, advancedPrompts } = context;
		const { logger, aiFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		logger.log(`[${directory.slug}] AI-Driven Structured Data Extraction for Items from Web - Starting`);

		const extractedWebItems = await this.extractItemsFromPages(
			directory.slug,
			request.name || directory.name,
			request.prompt || '',
			request.config || {},
			webPages,
			featuredItemHints,
			false,
			metrics,
			advancedPrompts?.itemExtraction,
			logger,
			aiFacade,
			facadeOptions
		);

		logger.log(`[${directory.slug}] Extracted ${extractedWebItems.length} potential items from web pages.`);

		context.extractedWebItems = extractedWebItems;

		return context;
	}

	/**
	 * Extract items from pages
	 */
	private async extractItemsFromPages(
		directorySlug: string,
		topicName: string,
		topicDescription: string,
		config: Record<string, unknown>,
		relevantPages: WebPageData[],
		featuredItemHints: string[] = [],
		withTags = false,
		metrics: PipelineMetrics,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		facadeOptions: FacadeOptions
	): Promise<MutableItemData[]> {
		if (!aiFacade.isConfigured()) {
			logger.warn(`[${directorySlug}] AI provider not configured. Skipping AI-driven item extraction.`);
			return [];
		}

		const minContentLength = (config.min_content_length_for_extraction as number) || 100;

		// Filter pages with sufficient content
		const pagesWithSufficientContent = relevantPages.filter((page) => {
			const hasSufficientContent = page.raw_content && page.raw_content.length >= minContentLength;

			if (!hasSufficientContent) {
				logger.debug(
					`[${directorySlug}] Skipping item extraction for page (insufficient content): ${page.source_url}`
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
		const extractItemsFromPage = async (page: WebPageData): Promise<MutableItemData[]> => {
			const extractedItems: MutableItemData[] = [];

			try {
				// Check if content is large enough to require chunking
				if (page.raw_content && page.raw_content.length > this.MAX_CHUNK_SIZE) {
					// Split the content into chunks
					const chunks = await this.textSplitter.splitText(page.raw_content);

					// Process each chunk
					const chunkResults = await Promise.all(
						chunks.map(async (chunk: string, index: number) => {
							try {
								const { result, usage, cost } = await aiFacade.askJson<
									ExtractedItems | ExtractedItemsWithTags
								>(
									finalPrompt,
									schema,
									{
										temperature: 0.1,
										variables: {
											topicName,
											topicDescription,
											page_content_snippet: chunk,
											featured_hints_section: featuredHintsSection
										},
										routing: {
											complexity: 'complex',
											taskId: 'item-extraction-chunk'
										}
									},
									facadeOptions
								);

								if (usage) {
									this.accumulateMetrics(metrics, usage, cost);
								}
								return result?.items || [];
							} catch (chunkError) {
								logger.error(
									`[${directorySlug}] Error processing chunk ${index + 1} from ${page.source_url}: ${this.formatError(chunkError)}`
								);
								return [];
							}
						})
					);

					// Combine all items from all chunks
					const allExtractedItems = chunkResults.flat();

					if (allExtractedItems.length > 0) {
						// Process and validate each extracted item
						const validatedItems: MutableItemData[] = [];
						for (const extractedItem of allExtractedItems) {
							try {
								const validatedItem = validationSchema.parse(
									this.convertNullsToUndefined(extractedItem)
								) as MutableItemData;

								validatedItem.slug = slugifyText(validatedItem.name);
								validatedItems.push(validatedItem);
							} catch {
								// Skip invalid items silently
							}
						}

						// Deduplicate items from different chunks
						const uniqueItems = this.deduplicateItems(validatedItems);
						extractedItems.push(...uniqueItems);
					} else {
						logger.debug(
							`[${directorySlug}] No items extracted by LLM from any chunks in ${page.source_url}`
						);
					}
				} else {
					// Process the entire content at once for smaller pages
					const {
						result: extractionResult,
						usage,
						cost
					} = await aiFacade.askJson<ExtractedItems | ExtractedItemsWithTags>(
						finalPrompt,
						schema,
						{
							temperature: 0.1,
							variables: {
								topicName,
								topicDescription,
								page_content_snippet: page.raw_content || '',
								featured_hints_section: featuredHintsSection
							},
							routing: {
								complexity: 'complex',
								taskId: 'item-extraction'
							}
						},
						facadeOptions
					);

					if (usage) {
						this.accumulateMetrics(metrics, usage, cost);
					}

					if (extractionResult && extractionResult.items && extractionResult.items.length > 0) {
						// Process and validate each extracted item
						const validatedItems: MutableItemData[] = [];
						for (const extractedItem of extractionResult.items) {
							try {
								const validatedItem = validationSchema.parse(
									this.convertNullsToUndefined(extractedItem)
								) as MutableItemData;

								validatedItem.slug = slugifyText(validatedItem.name);
								validatedItems.push(validatedItem);
							} catch {
								// Skip invalid items silently
							}
						}

						extractedItems.push(...validatedItems);
					} else {
						logger.debug(`[${directorySlug}] No items extracted by LLM from ${page.source_url}`);
					}
				}
			} catch (error) {
				logger.error(
					`[${directorySlug}] Error extracting items from ${page.source_url}: ${this.formatError(error)}`,
					getErrorStack(error)
				);
			}

			return extractedItems;
		};

		// Process pages in batches to avoid rate limits
		const allExtractedItems: MutableItemData[] = [];

		for (let i = 0; i < pagesWithSufficientContent.length; i += this.BATCH_SIZE) {
			const batch = pagesWithSufficientContent.slice(i, i + this.BATCH_SIZE);

			const extractionPromises = batch.map((page) => extractItemsFromPage(page));
			const batchResults = await Promise.all(extractionPromises);

			const extractedItemsFromBatch = batchResults.flat();
			allExtractedItems.push(...extractedItemsFromBatch);

			if (i + this.BATCH_SIZE < pagesWithSufficientContent.length) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}

		// Final deduplication across all pages
		const uniqueExtractedItems = this.deduplicateItems(allExtractedItems);

		if (uniqueExtractedItems.length < allExtractedItems.length) {
			logger.log(
				`[${directorySlug}] Deduplicated ${allExtractedItems.length - uniqueExtractedItems.length} duplicate items across all pages.`
			);
		}

		logger.log(
			`[${directorySlug}] Item extraction complete. Extracted ${uniqueExtractedItems.length} unique items from ${pagesWithSufficientContent.length} pages.`
		);
		return uniqueExtractedItems;
	}

	/**
	 * Convert null values to undefined for type compatibility
	 */
	private convertNullsToUndefined(item: Record<string, unknown>): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(item)) {
			result[key] = value === null ? undefined : value;
		}
		return result;
	}

	/**
	 * Deduplicate items based on name similarity
	 */
	private deduplicateItems(items: MutableItemData[]): MutableItemData[] {
		if (!items || items.length <= 1) {
			return items;
		}

		const uniqueItems = new Map<string, MutableItemData>();

		for (const item of items) {
			const normalizedName = item.name.toLowerCase().trim();
			const existingItem = uniqueItems.get(normalizedName);

			if (
				!uniqueItems.has(normalizedName) ||
				(!existingItem?.source_url && item.source_url) ||
				(existingItem?.source_url && item.source_url && existingItem.source_url.length > item.source_url.length)
			) {
				uniqueItems.set(normalizedName, item);
			}
		}

		return Array.from(uniqueItems.values());
	}

	/**
	 * Generate the featured hints section for the prompt
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

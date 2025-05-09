import { Injectable, Logger } from '@nestjs/common';
import {
  CreateItemsGeneratorDto,
  ConfigDto,
} from './dto/create-items-generator.dto';
import { ItemData } from './dto/item-data.dto';
import { Category } from './dto/category.dto';
import { Tag } from './dto/tag.dto';
import { ItemsGeneratorMetrics } from './dto/items-generator-response.dto';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import axios from 'axios';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  itemDataSchema,
  extractedItemsSchema,
  promptUnderstandingAssessmentSchema,
} from './schemas/item-extraction.schemas';
import {
  normalizedNamesListSchema,
  categoryDescriptionSchema,
} from './schemas/normalization.schemas';
import {
  WebPageData,
  RelevanceAssessment,
} from './interfaces/items-generator.interfaces';
import { extractTextFromHtml, slugify } from './utils/text.utils';
import { tavily, TavilyClient } from '@tavily/core';

// Default number of items to ask the AI to generate in the initial phase
const DEFAULT_AI_ITEMS_TO_GENERATE = 20;

const DEFAULT_CONFIG: Required<ConfigDto> = {
  max_search_queries: 10,
  max_results_per_query: 20,
  max_pages_to_process: 100,
  relevance_threshold_content: 0.75,
  min_content_length_for_extraction: 500,
};

@Injectable()
export class ItemsGeneratorService {
  private readonly logger = new Logger(ItemsGeneratorService.name);
  private llm: ChatOpenAI;
  private tavilyClient: TavilyClient | undefined;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      this.logger.warn(
        'OPENAI_API_KEY not found in .env file. AI features will be limited.',
      );
    }
    this.llm = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      modelName: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.7,
    });

    if (!process.env.TAVILY_API_KEY) {
      this.logger.warn(
        'TAVILY_API_KEY not found in .env file. Web search capabilities will be disabled.',
      );
    } else {
      this.tavilyClient = tavily({
        apiKey: process.env.TAVILY_API_KEY,
      });
    }
  }

  /**
   * Entry point for generating items.
   *
   * @param createItemsGeneratorDto
   * @param existing
   * @returns
   */
  async generateItemsGenerator(
    createItemsGeneratorDto: CreateItemsGeneratorDto,
    existing: {
      existingItems?: ItemData[];
      existingCategories?: Category[];
      existingTags?: Tag[];
    } = {},
  ) {
    const { slug, name, description, target_keywords } =
      createItemsGeneratorDto;
    const config = { ...DEFAULT_CONFIG, ...createItemsGeneratorDto.config };

    this.logger.log(`Starting generation for slug: ${slug}, name: ${name}`);

    try {
      const {
        existingItems = [],
        existingCategories = [],
        existingTags = [],
      } = existing;

      const processedSourceUrls = new Set<string>();

      if (existingItems.length) {
        this.logger.log(
          `Loaded ${existingItems.length} existing items for slug: ${slug}`,
        );
      }

      if (existingCategories.length) {
        this.logger.log(
          `Loaded ${existingCategories.length} existing categories for slug: ${slug}`,
        );
      }
      if (existingTags.length) {
        this.logger.log(
          `Loaded ${existingTags.length} existing tags for slug: ${slug}`,
        );
      }
      this.logger.log(`[${slug}] 1. Initialization & Slug Handling - Complete`);

      // 1.5. AI-First Item Generation
      this.logger.log(`[${slug}] 1.5. AI-First Item Generation - Invoking`);
      const initialAiItems: ItemData[] = await this.generateInitialItemsWithAI(
        slug,
        name,
        description,
        target_keywords,
        config,
      );
      this.logger.log(
        `[${slug}] AI generated ${initialAiItems.length} initial items.`,
      );

      // 2. AI-Powered Search Query Generation
      this.logger.log(
        `[${slug}] 2. AI-Powered Search Query Generation - Starting`,
      );
      const searchQueries = await this.generateSearchQueries(
        name,
        description,
        target_keywords,
        config,
      );
      this.logger.log(
        `[${slug}] Generated ${searchQueries.length} search queries.`,
      );

      // 3. Web Search & Content Retrieval
      this.logger.log(`[${slug}] 3. Web Search & Content Retrieval - Starting`);
      const webPages = await this.retrieveWebPages(
        slug,
        searchQueries,
        processedSourceUrls, // TODO: Consider if AI-generated URLs should be added here
        config,
      );
      this.logger.log(
        `[${slug}] Retrieved ${webPages.length} web pages for processing.`,
      );

      // 4. Content Pre-filtering & Relevance Assessment
      this.logger.log(
        `[${slug}] 4. Content Pre-filtering & Relevance Assessment - Starting`,
      );
      const relevantPages = await this.filterAndAssessPages(
        slug,
        webPages,
        name,
        description,
        config,
      );
      this.logger.log(
        `[${slug}] Filtered down to ${relevantPages.length} relevant pages.`,
      );

      // 5. AI-Driven Structured Data Extraction for Items (from Web)
      this.logger.log(
        `[${slug}] 5. AI-Driven Structured Data Extraction for Items from Web - Starting`,
      );
      const extractedWebItems: ItemData[] = await this.extractItemsFromPages(
        slug,
        relevantPages,
        name,
        description,
        config,
      );
      this.logger.log(
        `[${slug}] Extracted ${extractedWebItems.length} potential items from web pages.`,
      );

      // Combine AI-generated items and web-extracted items
      const allDiscoveredItems = [...initialAiItems, ...extractedWebItems];
      this.logger.log(
        `[${slug}] Total discovered items (AI + Web before source validation): ${allDiscoveredItems.length}.`,
      );

      // 6. Filter and Validate Source URLs for all discovered items
      this.logger.log(
        `[${slug}] 6. Filter and Validate Source URLs - Starting`,
      );
      const validatedItems = await this.filterAndValidateSourceItems(
        allDiscoveredItems,
        slug,
      );
      this.logger.log(
        `[${slug}] After source validation, ${validatedItems.length} items remain.`,
      );

      // 7. Category and Tag Generation, Normalization & Consolidation
      this.logger.log(
        `[${slug}] 7. Category and Tag Generation, Normalization & Consolidation - Starting`,
      );
      const { currentCategories, currentTags } =
        await this.processCategoriesAndTags(slug, validatedItems, name);

      this.logger.log(
        `[${slug}] Processed ${currentCategories.length} categories and ${currentTags.length} tags based on validated items.`,
      );

      // 8. Deduplication and Data Aggregation
      this.logger.log(
        `[${slug}] 8. Deduplication and Data Aggregation - Starting`,
      );
      const { finalItems, finalCategories, finalTags, metrics } =
        this.aggregateAndDeduplicateData(
          slug,
          existingItems,
          existingCategories,
          existingTags,
          validatedItems,
          currentCategories,
          currentTags,
          webPages.length,
          relevantPages.length,
        );

      this.logger.log(
        `[${slug}] Aggregated data: ${finalItems.length} items, ${finalCategories.length} categories, ${finalTags.length} tags.`,
      );

      this.logger.log(
        `[${slug}] Awesome list generation complete. Final metrics: ${JSON.stringify(metrics)}`,
      );

      // This is where a more robust notification (webhook, websocket, email) would be triggered,
      // potentially including the 'metrics'

      return {
        categories: finalCategories,
        items: finalItems,
        tags: finalTags,
      };
    } catch (error) {
      this.logger.error(
        `Error generating awesome list for slug ${slug}: ${error.message}`,
        error.stack,
      );
      // Update a status file or send a notification about the error
    }

    return null;
  }

  private async generateSearchQueries(
    name: string,
    description: string,
    targetKeywords: string[] | undefined,
    config: Required<ConfigDto>,
  ): Promise<string[]> {
    this.logger.log(`[${name}] Generating search queries using LLM...`);

    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${name}] OpenAI API Key not configured. Falling back to basic query generation.`,
      );
      const fallbackQueries = [
        `best tools for ${name}`,
        `${name} resources`,
        `${name} libraries`,
        `${name} tutorials`,
        `official documentation ${name}`,
        `community ${name}`,
      ];
      if (targetKeywords && targetKeywords.length > 0) {
        return [
          ...new Set([
            ...targetKeywords.map((kw) => `${kw} ${name}`),
            ...fallbackQueries,
          ]),
        ].slice(0, config.max_search_queries);
      }
      return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
    }

    const promptTemplate = PromptTemplate.fromTemplate(
      `You are an expert at generating highly relevant and diverse search engine queries to build an "Awesome List" about a specific topic.
The topic is: "{name}"
Description: "{description}"
Optional initial keywords: {target_keywords_string}

Generate {num_queries} distinct search queries. Each query should be on a new line.
The queries should aim to discover:
- Key tools and software
- Essential libraries and frameworks
- Seminal articles and blog posts
- Official documentation and guides
- Important community resources, forums, or discussions
- Common use cases and best practices
- Comparisons and alternatives

Consider variations, long-tail keywords, and queries targeting different facets of the topic.
Avoid overly broad or generic queries. Be specific.

Generated Queries:
`,
    );

    const queryGenerationChain = promptTemplate
      .pipe(this.llm)
      .pipe(new StringOutputParser());

    try {
      const result = await queryGenerationChain.invoke({
        name,
        description,
        target_keywords_string: targetKeywords
          ? targetKeywords.join(', ')
          : 'N/A',
        num_queries: config.max_search_queries * 2, // Generate more to allow for filtering
      });

      const queries = result
        .split('\n')
        .map((q) => q.trim().replace(/^- /, ''))
        .filter((q) => q.length > 5) // Filter out very short or empty lines
        .filter((q, index, self) => self.indexOf(q) === index); // Ensure uniqueness

      this.logger.log(
        `[${name}] LLM generated ${queries.length} unique queries.`,
      );
      return queries.slice(0, config.max_search_queries);
    } catch (error) {
      this.logger.error(
        `[${name}] Error generating search queries with LLM: ${error.message}`,
        error.stack,
      );
      this.logger.warn(
        `[${name}] Falling back to basic query generation due to LLM error.`,
      );
      // Fallback to simpler generation if LLM fails
      const fallbackQueries = [
        `best tools for ${name}`,
        `${name} resources`,
        `${name} libraries`,
        `${name} tutorials`,
        `official documentation ${name}`,
        `community ${name}`,
      ];
      if (targetKeywords && targetKeywords.length > 0) {
        return [
          ...new Set([
            ...targetKeywords.map((kw) => `${kw} ${name}`),
            ...fallbackQueries,
          ]),
        ].slice(0, config.max_search_queries);
      }
      return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
    }
  }

  private async retrieveWebPages(
    slug: string,
    searchQueries: string[],
    processedSourceUrls: Set<string>, // URLs from existing items.json
    config: Required<ConfigDto>,
  ): Promise<WebPageData[]> {
    if (!this.tavilyClient) {
      this.logger.warn(
        `[${slug}] Tavily API key not configured. Skipping web search.`,
      );
      return [];
    }

    const allFetchedPages: WebPageData[] = [];
    const currentRunProcessedUrls = new Set<string>();
    let pagesFetchedThisRun = 0;

    for (const query of searchQueries) {
      if (pagesFetchedThisRun >= config.max_pages_to_process) {
        this.logger.log(
          `[${slug}] Reached max_pages_to_process limit (${config.max_pages_to_process}). Stopping further web retrieval.`,
        );
        break;
      }

      this.logger.log(`[${slug}] Executing search query: "${query}"`);
      try {
        const documents = await this.webSearch(query, config);
        this.logger.log(
          `[${slug}] Found ${documents.length} results for query: "${query}"`,
        );

        for (const doc of documents.slice(0, config.max_results_per_query)) {
          if (pagesFetchedThisRun >= config.max_pages_to_process) break;

          const source_url = doc.url;
          if (!source_url || typeof source_url !== 'string') {
            this.logger.warn(
              `[${slug}] Skipping document with missing or invalid source URL for query "${query}". Metadata: ${JSON.stringify(doc)}`,
            );
            continue;
          }

          if (
            processedSourceUrls.has(source_url) ||
            currentRunProcessedUrls.has(source_url)
          ) {
            this.logger.log(
              `[${slug}] Skipping already processed URL: ${source_url}`,
            );
            continue;
          }

          this.logger.log(`[${slug}] Fetching content from: ${source_url}`);
          try {
            // Polite crawling: wait a bit
            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1-second delay

            const response = await axios.get(source_url, {
              headers: {
                'User-Agent': `ItemsGeneratorBuilder/${slug} (Node.js/Axios; +https://github.com/your-repo)`,
              },
              timeout: 15000, // 15-second timeout
              validateStatus: (status) => status >= 200 && status < 400, // Only consider 2xx and 3xx as success
            });

            if (
              response.headers['content-type'] &&
              !response.headers['content-type'].includes('text/html') &&
              !response.headers['content-type'].includes('text/plain')
            ) {
              this.logger.warn(
                `[${slug}] Skipping non-HTML/text content at ${source_url} (Content-Type: ${response.headers['content-type']})`,
              );
              currentRunProcessedUrls.add(source_url); // Mark as processed to avoid re-fetching
              continue;
            }

            const html_content = response.data;
            allFetchedPages.push({
              source_url,
              html_content,
              retrieved_at: new Date().toISOString(),
            });
            currentRunProcessedUrls.add(source_url);
            pagesFetchedThisRun++;
            this.logger.log(
              `[${slug}] Successfully fetched content from: ${source_url}. Total pages fetched this run: ${pagesFetchedThisRun}`,
            );
          } catch (fetchError) {
            this.logger.error(
              `[${slug}] Error fetching content from ${source_url}: ${fetchError.message}`,
            );
            currentRunProcessedUrls.add(source_url); // Add to processed to avoid retrying failed URLs in this run
          }
        }
      } catch (searchError) {
        this.logger.error(
          `[${slug}] Error executing search query "${query}" with Tavily: ${searchError.message}`,
        );
      }
    }
    return allFetchedPages;
  }

  private async filterAndAssessPages(
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
      const textContent = extractTextFromHtml(page.html_content);
      page.text_content = textContent; // Store extracted text for later use

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
        relevantPages.push(page); // Keep page if assessment fails, to not lose potentially good data
      }
    }
    return relevantPages;
  }

  private async extractItemsFromPages(
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
        'Extracts one or more distinct items (tools, resources, libraries, articles, etc.) from the provided web page content that are relevant to the awesome list topic, including generating relevant Markdown content.',
      parameters: zodToJsonSchema(extractedItemsSchema),
    };

    for (const page of relevantPages) {
      if (
        !page.text_content ||
        page.text_content.length < config.min_content_length_for_extraction
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
          `You are an expert data extractor and technical writer for "Awesome List" directories.
The **main topic** of the Awesome List is: "{topicName}" (Description: "{topicDescription}").
From the following web page content, identify and extract information for one or more distinct items (tools, resources, libraries, articles, etc.) that are **directly and highly relevant to this main topic**. Do NOT extract items that are only tangentially related or represent a different category unless it's explicitly part of "{topicName}".

Web Page Content (first 5000 characters):
---
{page_content_snippet}
---

For each identified item **that directly relates to "{topicName}"**:
1.  Provide its canonical **name**.
2.  Write a concise **description** highlighting its specific relevance to "{topicName}".
3.  Determine its most direct and canonical **source_url** (homepage, docs, repo etc.). Do not use URLs for blog posts merely mentioning the item unless the post *is* the primary resource. The URL must be valid and specific to the item.
4.  List relevant high-level **categories** (e.g., "Monitoring", "Security") that fit within the context of "{topicName}".
5.  List specific **tags** (keywords, technologies, e.g., "open-source", "real-time").
6.  Determine if it should be **featured** based on prominence/recommendations.
7.  Generate **markdown_content**: Extract the *most relevant* information from the page content and format it as clean Markdown. Follow these rules strictly:
    *   **Focus:** Prioritize factual information, technical details, features, capabilities, and pricing/plans (if applicable and clearly stated).
    *   **Exclude:** All marketing/sales language (e.g., "revolutionary", "best-in-class", "why choose us"), testimonials, customer logos, generic "About Us" sections unrelated to the item's function, generic support/contact information, and calls to action (e.g., "Sign up now", "Request a demo").
    *   **Features:** List *all* relevant features mentioned, not just key features. Use bullet points under a "### Features" heading if appropriate.
    *   **Pricing:** If pricing information (plans, tiers, costs) is present and clear, include it under a "### Pricing" heading. Summarize clearly.
    *   **Structure:** Use appropriate Markdown headings (e.g., \`### Features\`, \`### Pricing\`), bullet points, and code formatting where applicable. Keep it concise and informative.
    *   **Length:** Aim for a useful summary (typically 100-500 words), not the entire page content.

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
          page_content_snippet: page.text_content.slice(0, 5000), // Use a larger snippet for extraction + markdown
        })) as { items?: Partial<ItemData>[] }; // Type assertion for the expected output structure

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
                featured: false, // Default featured if not provided by LLM
                ...extractedItem,
              };
              // The itemDataSchema now includes markdown_content, so it will be validated
              const validatedItem = itemDataSchema.parse(
                itemToValidate,
              ) as ItemData; // Cast to ItemData after successful parsing

              // Auto-generate slug if not provided or to ensure consistency
              validatedItem.slug = (validatedItem.slug || validatedItem.name)
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9-]/g, '');

              allExtractedItems.push(validatedItem);
              this.logger.log(
                `[${slug}] Extracted item: "${validatedItem.name}" (Slug: ${validatedItem.slug}) with markdown_content from ${page.source_url}`,
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

  private async filterAndValidateSourceItems(
    items: ItemData[],
    slug: string,
  ): Promise<ItemData[]> {
    this.logger.log(
      `[${slug}] Starting source URL validation and filtering for ${items.length} items.`,
    );
    const validItems: ItemData[] = [];

    try {
      for (const currentItem of items) {
        const validatedSourceUrl = await this.validateAndFetchSourceUrl(
          slug,
          currentItem,
        );

        if (validatedSourceUrl) {
          const updatedItem: ItemData = {
            ...currentItem,
            source_url: validatedSourceUrl,
          };
          validItems.push(updatedItem);
        }
      }
    } catch (error) {
      this.logger.error(
        `[${slug}] Error during source URL validation: ${error.message}`,
        error.stack,
      );
    }

    this.logger.log(
      `[${slug}] Finished source URL validation. ${validItems.length} of ${items.length} items passed.`,
    );

    return validItems;
  }

  private async generateInitialItemsWithAI(
    slug: string,
    topicName: string,
    topicDescription: string,
    targetKeywords: string[] | undefined,
    config: Required<ConfigDto>,
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
        'Assesses if the provided topic, description, and keywords are clear and specific enough to generate a meaningful list of items for an Awesome List.',
      parameters: zodToJsonSchema(promptUnderstandingAssessmentSchema),
    };

    const understandingPrompt = PromptTemplate.fromTemplate(
      `You are an AI assistant helping to curate an "Awesome List".
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
        'Generates a list of distinct items (tools, resources, libraries, articles, etc.) that are highly relevant to the awesome list topic, including their details.',
      parameters: zodToJsonSchema(extractedItemsSchema),
    };

    const generationPrompt = PromptTemplate.fromTemplate(
      `You are an expert curator and technical writer tasked with generating an initial list of items for an "Awesome List" about a specific topic.
The **main topic** of the Awesome List is: "{topicName}"
Description: "{topicDescription}"
Optional initial keywords: {target_keywords_string}

Based on this topic, please generate a comprehensive list of approximately {num_items_to_generate} distinct items (e.g., tools, software, libraries, frameworks, seminal articles, official documentation, key community resources, important projects).

For each item, provide the following details:
1.  **name**: The canonical name of the item.
2.  **description**: A concise description (1-3 sentences) highlighting its specific relevance to "{topicName}".
3.  **source_url**: The most direct and canonical URL (e.g., homepage, official documentation, repository). If a high-quality, canonical URL cannot be confidently determined, you may omit it but it's highly encouraged.
4.  **category**: Suggest one or two high-level categories this item belongs to within the context of "{topicName}" (e.g., "Data Visualization", "State Management", "Security Tooling"). This is a preliminary suggestion.
5.  **tags**: List 3-5 specific keywords or tags (e.g., "open-source", "javascript", "real-time", "cli").
6.  **featured**: A boolean indicating if this item is highly prominent or recommended (true/false). Default to false if unsure.
7.  **markdown_content**: (Optional for initial generation, can be brief) A very short summary or key features in Markdown format (50-150 words) of its core purpose and relevance.

**Critical Instructions:**
-   Focus on **relevance** to "{topicName}".
-   Aim for **diversity** in the types of items if appropriate for the topic.
-   Provide **accurate and canonical** information, especially for names and URLs.
-   If the topic is broad, try to cover its main sub-areas. If it's niche, focus on key resources for that niche.

Generate the list of items according to the specified schema.
`,
    );

    const generationChain = generationPrompt
      .pipe(
        this.llm.bind({
          functions: [itemGenerationFunction],
          function_call: { name: 'generate_awesome_list_items_directly' },
        }),
      )
      .pipe(new JsonOutputFunctionsParser());

    // reset temperature
    const defaultTemperature = this.llm.temperature;
    this.llm.temperature = 0.2;

    try {
      const numItemsToGenerate =
        config.max_results_per_query * 1 || DEFAULT_AI_ITEMS_TO_GENERATE;

      const result = (await generationChain.invoke({
        topicName,
        topicDescription,
        target_keywords_string: targetKeywords
          ? targetKeywords.join(', ')
          : 'N/A',
        num_items_to_generate: numItemsToGenerate,
      })) as { items?: Partial<ItemData>[] };

      if (result && result.items && result.items.length > 0) {
        this.logger.log(
          `[${slug}] AI initially generated ${result.items.length} items.`,
        );
        for (const generatedItem of result.items) {
          try {
            const itemToValidate: Partial<ItemData> = {
              featured: false,
              markdown_content: generatedItem.markdown_content || '',
              tags: generatedItem.tags || [],
              category: [],
              ...generatedItem,
            };

            if (generatedItem.category) {
              if (typeof generatedItem.category === 'string') {
                itemToValidate.category = [
                  generatedItem.category.trim(),
                ].filter((c) => c);
              } else if (Array.isArray(generatedItem.category)) {
                itemToValidate.category = generatedItem.category
                  .map((c) => c.trim())
                  .filter((c) => c);
              }
            } else {
              itemToValidate.category = [];
            }

            if (generatedItem.tags && Array.isArray(generatedItem.tags)) {
              itemToValidate.tags = generatedItem.tags
                .map((t) => t.trim())
                .filter((t) => t);
            } else {
              itemToValidate.tags = [];
            }

            const validatedItem = itemDataSchema.parse(
              itemToValidate,
            ) as ItemData;

            validatedItem.slug = slugify(validatedItem.name);

            if (!validatedItem.source_url) {
              this.logger.warn(
                `[${slug}] AI generated item "${validatedItem.name}" without a source_url. Deduplication might be affected.`,
              );
            }
            allGeneratedItems.push(validatedItem);
          } catch (validationError) {
            this.logger.warn(
              `[${slug}] Discarding AI-generated item due to validation error: ${validationError.errors.map((e) => e.message).join(', ')}. Item: ${JSON.stringify(generatedItem)}`,
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

    this.llm.temperature = defaultTemperature;

    this.logger.log(
      `[${slug}] AI-First Item Generation - Complete. Validated ${allGeneratedItems.length} items.`,
    );
    return allGeneratedItems;
  }

  private async normalizeTerms(
    slug: string,
    terms: string[],
    termType: 'category' | 'tag',
    topicName: string,
  ): Promise<Map<string, string>> {
    if (!this.llm.apiKey || terms.length === 0) {
      this.logger.warn(
        `[${slug}] OpenAI API Key not configured or no ${termType} terms to normalize. Using original terms.`,
      );
      const map = new Map<string, string>();
      terms.forEach((term) => map.set(term, term)); // Simple 1:1 mapping
      return map;
    }

    const normalizationFunction = {
      name: `normalize_${termType}_names`,
      description: `Normalizes a list of ${termType} names to their canonical forms, considering the context of an Awesome List about "${topicName}". For example, "ML", "Machine Learning", and "machine-learning" should all normalize to "Machine Learning".`,
      parameters: zodToJsonSchema(normalizedNamesListSchema),
    };

    const prompt = PromptTemplate.fromTemplate(
      `You are an expert in data normalization for software and technology topics.
The Awesome List topic is: "{topicName}".
Given the following list of raw {termType} names, please normalize them to their most common, canonical forms.
Consider synonyms, abbreviations, and different capitalizations.
Ensure the normalized names are suitable for display in a curated list.

Raw {termType} names (one per line):
{term_list_string}

Return the list of original names paired with their normalized versions.
`,
    );

    const outputParser = new JsonOutputFunctionsParser();
    const normalizationChain = prompt
      .pipe(
        this.llm.bind({
          functions: [normalizationFunction],
          function_call: { name: normalizationFunction.name },
        }),
      )
      .pipe(outputParser);

    const normalizedMap = new Map<string, string>();
    // Process in chunks if the list is very long to avoid overly large prompts
    const chunkSize = 50;
    for (let i = 0; i < terms.length; i += chunkSize) {
      const chunk = terms.slice(i, i + chunkSize);
      try {
        this.logger.log(
          `[${slug}] Normalizing ${termType} chunk: ${chunk.join(', ')}`,
        );
        const result = (await normalizationChain.invoke({
          topicName,
          termType,
          term_list_string: chunk.join('\n'),
        })) as {
          normalized_names?: {
            original_name: string;
            normalized_name: string;
          }[];
        };

        if (result && result.normalized_names) {
          result.normalized_names.forEach((pair) => {
            normalizedMap.set(pair.original_name, pair.normalized_name);
          });
        } else {
          this.logger.warn(
            `[${slug}] LLM did not return expected structure for ${termType} normalization chunk. Using original terms for this chunk.`,
          );
          chunk.forEach((term) => normalizedMap.set(term, term));
        }
      } catch (error) {
        this.logger.error(
          `[${slug}] Error normalizing ${termType} chunk with LLM: ${error.message}. Using original terms for this chunk.`,
          error.stack,
        );
        chunk.forEach((term) => normalizedMap.set(term, term));
      }
    }
    return normalizedMap;
  }

  private async generateCategoryDescription(
    slug: string,
    categoryName: string,
    topicName: string,
  ): Promise<string | undefined> {
    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${slug}] OpenAI API Key not configured. Skipping category description generation for "${categoryName}".`,
      );
      return undefined;
    }

    const descriptionFunction = {
      name: 'generate_category_description',
      description: `Generates a brief, informative description for the category "${categoryName}" within the context of an Awesome List about "${topicName}".`,
      parameters: zodToJsonSchema(categoryDescriptionSchema),
    };

    const prompt = PromptTemplate.fromTemplate(
      `You are an expert technical writer creating content for an "Awesome List".
The Awesome List topic is: "{topicName}".
The category is: "{categoryName}".

Please generate a concise (1-2 sentences) and informative description for this category.
The description should explain what kind of items or resources typically fall under this category in the context of "{topicName}".
`,
    );

    const outputParser = new JsonOutputFunctionsParser();
    const descriptionChain = prompt
      .pipe(
        this.llm.bind({
          functions: [descriptionFunction],
          function_call: { name: descriptionFunction.name },
        }),
      )
      .pipe(outputParser);

    try {
      this.logger.log(
        `[${slug}] Generating description for category: "${categoryName}"`,
      );
      const result = (await descriptionChain.invoke({
        topicName,
        categoryName,
      })) as { category_name: string; description: string };

      return result.description;
    } catch (error) {
      this.logger.error(
        `[${slug}] Error generating description for category "${categoryName}" with LLM: ${error.message}`,
        error.stack,
      );
      return undefined;
    }
  }

  private async validateAndFetchSourceUrl(
    slug: string,
    currentItem: ItemData,
  ): Promise<string | undefined> {
    const sourceUrl = currentItem.source_url;
    const itemName = currentItem.name;
    const itemDescription = currentItem.description;

    const validateUrl = async (
      urlToValidate: string,
    ): Promise<string | undefined> => {
      if (!urlToValidate || typeof urlToValidate !== 'string') {
        this.logger.warn(
          `[${slug}] Invalid URL structure provided for URL for "${itemName}": ${urlToValidate}`,
        );
        return undefined;
      }

      try {
        new URL(urlToValidate); // Basic syntax check
        this.logger.log(
          `[${slug}] Validating provided URL for "${itemName}": ${urlToValidate}`,
        );
        await axios.head(urlToValidate, {
          timeout: 10000, // 10-second timeout
          validateStatus: (status) => status >= 200 && status < 400, // Allow 2xx and 3xx (redirects)
          headers: {
            'User-Agent': `ItemsGeneratorBuilder-URL-Validation/${slug}`,
          },
        });

        this.logger.log(
          `[${slug}] URL validation successful for "${itemName}": ${urlToValidate}`,
        );
        return urlToValidate;
      } catch (error) {
        this.logger.warn(
          `[${slug}] provided URL for "${itemName}" ("${urlToValidate}") failed validation: ${error.message}.`,
        );
        return undefined;
      }
    };

    const validatedInitialUrl = await validateUrl(sourceUrl);
    if (validatedInitialUrl) {
      return validatedInitialUrl;
    }

    if (!this.tavilyClient) {
      this.logger.warn(
        `[${slug}] Tavily retriever not available. Cannot search for URL for "${itemName}".`,
      );
      return undefined;
    }

    try {
      // Ensure itemName and itemDescription are strings before using them in search query
      const safeItemName = typeof itemName === 'string' ? itemName : 'item';

      const safeItemDescription =
        typeof itemDescription === 'string'
          ? itemDescription.substring(0, 100)
          : '';

      const searchQuery = `${safeItemName} ${safeItemDescription}`.trim();

      if (!searchQuery) {
        this.logger.warn(
          `[${slug}] Cannot perform Tavily search for "${itemName}" due to empty search query.`,
        );
        return undefined;
      }

      this.logger.log(
        `[${slug}] Searching Tavily for "${itemName}" with query: "${searchQuery}"`,
      );

      const documents = await this.webSearch(searchQuery, {
        max_results_per_query: 3,
      });

      if (documents && documents.length > 0) {
        for (const doc of documents) {
          if (doc.url) {
            const validatedTavilyUrl = await validateUrl(doc.url);
            if (validatedTavilyUrl) {
              this.logger.log(
                `[${slug}] Found and validated Tavily URL for "${itemName}": ${validatedTavilyUrl}`,
              );

              return validatedTavilyUrl;
            }
          }
        }
        this.logger.warn(
          `[${slug}] Tavily found URLs for "${itemName}", but none passed validation.`,
        );
      } else {
        this.logger.warn(
          `[${slug}] Tavily search found no results for "${itemName}" with query "${searchQuery}".`,
        );
      }
    } catch (tavilyError) {
      this.logger.error(
        `[${slug}] Error during Tavily search for "${itemName}": ${tavilyError.message}`,
        tavilyError.stack,
      );
    }

    this.logger.warn(
      `[${slug}] Could not find or validate a source URL for "${itemName}" after AI and Tavily attempts.`,
    );
    return undefined; // No valid URL found
  }

  private async webSearch(query: string, config?: ConfigDto) {
    const searches = await this.tavilyClient.search(query, {
      maxResults:
        config.max_results_per_query || DEFAULT_CONFIG.max_results_per_query,
    });

    return searches.results.sort((a, b) => b.score - a.score);
  }

  private async processCategoriesAndTags(
    slug: string,
    extractedItems: ItemData[],
    topicName: string,
  ): Promise<{ currentCategories: Category[]; currentTags: Tag[] }> {
    const rawCategories = new Set<string>();
    const rawTags = new Set<string>();

    extractedItems.forEach((item) => {
      if (item.category) {
        if (Array.isArray(item.category)) {
          item.category.forEach((c) => rawCategories.add(c.trim()));
        } else {
          rawCategories.add(item.category.trim());
        }
      }
      item.tags.forEach((t) => rawTags.add(t.trim()));
    });

    const uniqueRawCategories = Array.from(rawCategories).filter((c) => c);
    const uniqueRawTags = Array.from(rawTags).filter((t) => t);

    this.logger.log(
      `[${slug}] Found ${uniqueRawCategories.length} unique raw categories and ${uniqueRawTags.length} unique raw tags.`,
    );

    const normalizedCategoryMap = await this.normalizeTerms(
      slug,
      uniqueRawCategories,
      'category',
      topicName,
    );
    const normalizedTagMap = await this.normalizeTerms(
      slug,
      uniqueRawTags,
      'tag',
      topicName,
    );

    const finalCategoriesMap = new Map<string, Category>();
    for (const rawCat of uniqueRawCategories) {
      const normalizedName = normalizedCategoryMap.get(rawCat) || rawCat;
      const id = slugify(normalizedName);
      if (!finalCategoriesMap.has(id)) {
        const description = await this.generateCategoryDescription(
          slug,
          normalizedName,
          topicName,
        );
        finalCategoriesMap.set(id, {
          id,
          name: normalizedName,
          description: description || undefined, // Ensure it's explicitly undefined if not generated
          // icon_url: undefined, // Placeholder for future icon logic
        });
        this.logger.log(
          `[${slug}] Created category: ID=${id}, Name=${normalizedName}`,
        );
      }
    }

    // Update item categories to use normalized names or IDs
    // This part is tricky as items might have multiple categories, and we need to map them.
    // For simplicity, we'll assume items will store the normalized category NAME for now.
    // A more robust system might store category IDs in items.
    extractedItems.forEach((item) => {
      if (item.category) {
        if (Array.isArray(item.category)) {
          item.category = item.category.map(
            (catName) => normalizedCategoryMap.get(catName) || catName,
          );
        } else {
          item.category =
            normalizedCategoryMap.get(item.category) || item.category;
        }
      }
    });

    const finalTagsMap = new Map<string, Tag>();
    uniqueRawTags.forEach((rawTag) => {
      const normalizedName = normalizedTagMap.get(rawTag) || rawTag;
      const id = slugify(normalizedName);
      if (!finalTagsMap.has(id)) {
        finalTagsMap.set(id, { id, name: normalizedName });
        this.logger.log(
          `[${slug}] Created tag: ID=${id}, Name=${normalizedName}`,
        );
      }
    });

    // Update item tags to use normalized names
    extractedItems.forEach((item) => {
      item.tags = item.tags.map(
        (tagName) => normalizedTagMap.get(tagName) || tagName,
      );
    });

    return {
      currentCategories: Array.from(finalCategoriesMap.values()),
      currentTags: Array.from(finalTagsMap.values()),
    };
  }

  private aggregateAndDeduplicateData(
    slug: string,
    existingItems: ItemData[],
    existingCategories: Category[],
    existingTags: Tag[],
    newlyExtractedItemsThisRun: ItemData[],
    processedCategoriesThisRun: Category[],
    processedTagsThisRun: Tag[],
    urlsScannedThisRun: number,
    pagesProcessedThisRun: number,
  ): {
    finalItems: ItemData[];
    finalCategories: Category[];
    finalTags: Tag[];
    metrics: ItemsGeneratorMetrics;
  } {
    this.logger.log(`[${slug}] Starting data aggregation and deduplication.`);
    let newItemsAddedToStoreCount = 0;

    // Deduplicate Items
    const finalItemsMap = new Map<string, ItemData>();

    const getItemKey = (item: ItemData): string => {
      if (item.source_url) {
        // Normalize URL slightly to catch common variations if needed, e.g. remove trailing slash
        try {
          const url = new URL(item.source_url);
          return (url.origin + url.pathname).replace(/\/$/, ''); // Normalize: remove trailing slash
        } catch (e) {
          return item.source_url;
        }
      }

      return `https://www.google.com/search?q=${item.name}`;
    };

    existingItems.forEach((item) => {
      const key = getItemKey(item);
      finalItemsMap.set(key, item);
    });

    newlyExtractedItemsThisRun.forEach((newItem) => {
      // newlyExtractedItemsThisRun is allDiscoveredItems
      const key = getItemKey(newItem);
      const alreadyExisted = finalItemsMap.has(key);

      // Overwrite with newItem to ensure latest data (e.g. AI might have better initial description)
      // or if web extraction provides more markdown_content for an AI-stubbed item.
      // Logic for merging can be more sophisticated here if needed.
      const oldItem = finalItemsMap.get(key);
      finalItemsMap.set(key, newItem);

      if (!alreadyExisted) {
        newItemsAddedToStoreCount++;
        this.logger.log(
          `[${slug}] Adding new item: "${newItem.name}" (Key: ${key})`,
        );
      } else {
        // If item existed, check if we should log an update or merge
        if (oldItem && newItem.markdown_content && !oldItem.markdown_content) {
          this.logger.log(
            `[${slug}] Updating item "${newItem.name}" (Key: ${key}) with new markdown content.`,
          );
        } else {
          this.logger.log(
            `[${slug}] Item "${newItem.name}" (Key: ${key}) already exists or was updated.`,
          );
        }
      }
    });

    const finalItems = Array.from(finalItemsMap.values());

    // Deduplicate Categories
    const finalCategoriesMap = new Map<string, Category>();
    existingCategories.forEach((cat) => finalCategoriesMap.set(cat.id, cat));
    processedCategoriesThisRun.forEach((newCat) => {
      const existingCat = finalCategoriesMap.get(newCat.id);
      if (!existingCat) {
        finalCategoriesMap.set(newCat.id, newCat);
        this.logger.log(
          `[${slug}] Adding new category: "${newCat.name}" (ID: ${newCat.id})`,
        );
      } else {
        if (newCat.description && !existingCat.description) {
          existingCat.description = newCat.description;
          this.logger.log(
            `[${slug}] Updated description for existing category: "${newCat.name}"`,
          );
        }
      }
    });
    const finalCategories = Array.from(finalCategoriesMap.values());

    // Deduplicate Tags
    const finalTagsMap = new Map<string, Tag>();
    existingTags.forEach((tag) => finalTagsMap.set(tag.id, tag));
    processedTagsThisRun.forEach((newTag) => {
      if (!finalTagsMap.has(newTag.id)) {
        finalTagsMap.set(newTag.id, newTag);
        this.logger.log(
          `[${slug}] Adding new tag: "${newTag.name}" (ID: ${newTag.id})`,
        );
      }
    });
    const finalTags = Array.from(finalTagsMap.values());

    const metrics: ItemsGeneratorMetrics = {
      urls_scanned: urlsScannedThisRun,
      pages_processed: pagesProcessedThisRun,
      items_extracted_current_run: newlyExtractedItemsThisRun.length,
      new_items_added_to_store: newItemsAddedToStoreCount,
      total_items_in_store: finalItems.length,
      total_categories_in_store: finalCategories.length,
      total_tags_in_store: finalTags.length,
    };

    return { finalItems, finalCategories, finalTags, metrics };
  }
}

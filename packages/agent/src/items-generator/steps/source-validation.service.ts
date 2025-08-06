import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { ItemData, ConfigDto } from '../dto';
import { AiService, BaseChatModel } from 'src/ai';
import { SearchService } from '../shared';

// Schema for AI URL validation response
const urlValidationSchema = z.object({
    is_official: z
        .boolean()
        .describe('Whether this URL appears to be the official/canonical source for the item'),
    is_relevant: z
        .boolean()
        .describe(
            'Whether this URL is relevant to the item (not a random blog post or unrelated content)',
        ),
    confidence_score: z
        .number()
        .min(0)
        .max(1)
        .describe('Confidence score from 0 to 1 for this assessment'),
    url_type: z
        .enum([
            'official_website',
            'github_repository',
            'documentation',
            'blog_post',
            'news_article',
            'marketplace',
            'other',
        ])
        .describe('Type of URL/website'),
    reasoning: z.string().describe('Brief explanation of why this URL was classified this way'),
});

// Prompt for AI URL validation
const URL_VALIDATION_PROMPT = `
You are an expert at identifying official and canonical URLs for software tools, libraries, frameworks, and other technical items.

Given an item name, description, and a candidate URL with its content, determine if this URL is the official/canonical source for the item.

Item Name: {itemName}
Item Description: {itemDescription}
Candidate URL: {candidateUrl}
Page Content (first 2000 chars): {pageContent}

Analyze the URL and content to determine:
1. Is this the official website, GitHub repository, or primary documentation for the item?
2. Is this just a blog post, news article, or secondary source talking about the item?
3. How confident are you in this assessment?

Consider these factors:
- Domain authority (official domains like github.com, npmjs.com, official project domains)
- Content type (project homepage, documentation, repository vs blog post, news article)
- URL structure (official paths vs blog post paths)
- Content relevance and authority
- Whether the content is about the item or just mentions it

Prefer official sources in this order:
1. Official project website/homepage
2. GitHub/GitLab repository
3. Official documentation
4. Package manager pages (npm, PyPI, etc.)
5. Avoid: blog posts, news articles, tutorials, unless they are the only authoritative source
`;

@Injectable()
export class SourceValidationService {
    private readonly logger = new Logger(SourceValidationService.name);
    private llm: BaseChatModel;

    constructor(
        private readonly searchService: SearchService,
        private readonly aiService: AiService,
    ) {
        this.llm = this.aiService.createLlmWithTemperature(0.1); // Low temperature for consistent analysis
    }

    async filterAndValidateSourceItems(
        directorySlug: string,
        items: ItemData[],
    ): Promise<ItemData[]> {
        this.logger.log(`Starting source URL validation and filtering for ${items.length} items.`);

        if (!items || items.length === 0) {
            this.logger.log(`No items to validate.`);
            return [];
        }

        // Process items in batches
        const BATCH_SIZE = 15;
        const validItems: ItemData[] = [];
        const startTime = Date.now();

        try {
            // Process items in batches
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                const batch = items.slice(i, i + BATCH_SIZE);
                const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
                const totalBatches = Math.ceil(items.length / BATCH_SIZE);

                this.logger.log(
                    `Processing batch ${batchNumber} of ${totalBatches} (${batch.length} items)`,
                );

                // Process all items in the batch in parallel
                const validationPromises = batch.map((item) => {
                    return this.validateAndFetchSourceUrl(directorySlug, item)
                        .then((validatedSourceUrl) => {
                            if (validatedSourceUrl) {
                                return {
                                    ...item,
                                    source_url: validatedSourceUrl,
                                    valid: true,
                                };
                            }
                            return { ...item, valid: false };
                        })
                        .catch((error) => {
                            this.logger.error(
                                `Error validating URL for "${item.name}": ${error.message}`,
                                error.stack,
                            );
                            return { ...item, valid: false };
                        });
                });

                const batchResults = await Promise.all(validationPromises);

                // Filter valid items and add them to the result
                const validBatchItems = batchResults
                    .filter((item) => item.valid)
                    .map(({ valid, ...item }) => item);
                validItems.push(...validBatchItems);

                this.logger.log(
                    `Batch ${batchNumber} complete. ${validBatchItems.length} of ${batch.length} items passed validation.`,
                );

                // Add a small delay between batches to be polite to external servers
                if (i + BATCH_SIZE < items.length) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        } catch (error) {
            this.logger.error(`Error during source URL validation: ${error.message}`, error.stack);
        }

        const processingTime = (Date.now() - startTime) / 1000;
        this.logger.log(
            `Finished source URL validation in ${processingTime.toFixed(2)}s. ${validItems.length} of ${items.length} items passed.`,
        );

        return validItems;
    }

    private async validateAndFetchSourceUrl(
        directorySlug: string,
        currentItem: ItemData,
    ): Promise<string | undefined> {
        const sourceUrl = currentItem.source_url;
        const itemName = currentItem.name;
        const itemDescription = currentItem.description;

        // Check if the source URL starts with Google search URL patterns
        if (this.isGoogleSearchUrl(sourceUrl)) {
            this.logger.log(`Ignoring item "${itemName}" with Google search URL: ${sourceUrl}`);
            return undefined;
        }

        const validateUrl = async (urlToValidate: string): Promise<string | undefined> => {
            if (!urlToValidate || typeof urlToValidate !== 'string') {
                this.logger.warn(
                    `Invalid URL structure provided for URL for "${itemName}": ${urlToValidate}`,
                );
                return undefined;
            }

            // Check if this URL is a Google search URL
            if (this.isGoogleSearchUrl(urlToValidate)) {
                this.logger.warn(`Skipping Google search URL for "${itemName}": ${urlToValidate}`);
                return undefined;
            }

            try {
                // Basic syntax check
                try {
                    new URL(urlToValidate);
                } catch (urlError) {
                    this.logger.warn(`Invalid URL format for "${itemName}": ${urlToValidate}`);
                    return undefined;
                }

                this.logger.log(`Validating provided URL for "${itemName}": ${urlToValidate}`);

                await axios.head(urlToValidate, {
                    timeout: 10000, // 10-second timeout
                    validateStatus: (status) => status >= 200 && status < 400, // Allow 2xx and 3xx (redirects)
                    headers: {
                        'User-Agent': `ItemsGeneratorBuilder-URL-Validation/${directorySlug}`,
                    },
                });

                this.logger.log(`URL validation successful for "${itemName}": ${urlToValidate}`);
                return urlToValidate;
            } catch (error) {
                this.logger.warn(
                    `provided URL for "${itemName}" ("${urlToValidate}") failed validation: ${error.message}.`,
                );
                return undefined;
            }
        };

        // Try to validate the original source URL first
        const validatedInitialUrl = await validateUrl(sourceUrl);
        if (validatedInitialUrl) {
            return validatedInitialUrl;
        }

        try {
            // Ensure itemName and itemDescription are strings before using them in search query
            const safeItemName = typeof itemName === 'string' ? itemName : 'item';
            const safeItemDescription =
                typeof itemDescription === 'string' ? itemDescription.substring(0, 100) : '';

            // Generate multiple targeted search queries for better results
            const searchQueries = this.generateOfficialSourceQueries(
                safeItemName,
                safeItemDescription,
            );

            this.logger.log(
                `Searching for official source for "${itemName}" using ${searchQueries.length} targeted queries`,
            );

            // Search with multiple queries and collect all results
            const allDocuments = [];
            for (const query of searchQueries) {
                try {
                    const documents = await this.webSearch(query, {
                        max_results_per_query: 3, // Fewer results per query since we have multiple queries
                    });
                    if (documents && documents.length > 0) {
                        allDocuments.push(...documents);
                    }
                } catch (searchError) {
                    this.logger.warn(`Search failed for query "${query}": ${searchError.message}`);
                }
            }

            if (allDocuments.length === 0) {
                this.logger.warn(`No search results found for "${itemName}" across all queries.`);
                return undefined;
            }

            // Remove duplicates and filter valid URLs
            const uniqueUrls = Array.from(
                new Set(
                    allDocuments
                        .filter((doc) => doc.url && typeof doc.url === 'string')
                        .map((doc) => doc.url),
                ),
            );

            if (uniqueUrls.length === 0) {
                this.logger.warn(`No valid URLs found in search results for "${itemName}".`);
                return undefined;
            }

            this.logger.log(
                `Found ${uniqueUrls.length} unique URLs for "${itemName}". Analyzing with AI to find official source.`,
            );

            // Use AI to validate URLs and find the best official source
            const urlAnalysisPromises = uniqueUrls.slice(0, 8).map(async (url) => {
                // Limit to 8 URLs to avoid excessive API calls
                const basicValidation = await validateUrl(url);
                if (!basicValidation) {
                    return null;
                }

                const aiValidation = await this.validateUrlWithAI(
                    safeItemName,
                    safeItemDescription,
                    url,
                );
                return {
                    url,
                    aiValidation,
                };
            });

            const urlAnalysisResults = await Promise.all(urlAnalysisPromises);
            const validResults = urlAnalysisResults.filter((result) => result !== null);

            if (validResults.length === 0) {
                this.logger.warn(`No URLs passed basic validation for "${itemName}".`);
                return undefined;
            }

            // Find the best URL based on AI analysis
            let bestUrl = null;
            let bestScore = 0;

            for (const result of validResults) {
                if (result.aiValidation) {
                    const { isOfficial, confidence } = result.aiValidation;
                    const score = isOfficial ? confidence : confidence * 0.3; // Heavily penalize non-official sources

                    this.logger.log(
                        `URL analysis for "${itemName}" -> ${result.url}: official=${isOfficial}, confidence=${confidence}, score=${score}`,
                    );

                    if (score > bestScore) {
                        bestScore = score;
                        bestUrl = result.url;
                    }
                } else {
                    // If AI validation failed, consider it as a fallback with low score
                    if (bestScore === 0) {
                        bestUrl = result.url;
                        bestScore = 0.1;
                    }
                }
            }

            if (bestUrl && bestScore > 0.5) {
                this.logger.log(
                    `Found high-confidence official URL for "${itemName}": ${bestUrl} (score: ${bestScore})`,
                );
                return bestUrl;
            } else if (bestUrl && bestScore > 0.2) {
                this.logger.log(
                    `Found medium-confidence URL for "${itemName}": ${bestUrl} (score: ${bestScore})`,
                );
                return bestUrl;
            } else {
                this.logger.warn(
                    `No high-confidence official URL found for "${itemName}". Best candidate: ${bestUrl} (score: ${bestScore})`,
                );
                // Return the best candidate even if confidence is low, but log it
                return bestUrl;
            }
        } catch (tavilyError) {
            this.logger.error(
                `Error during Tavily search for "${itemName}": ${tavilyError.message}`,
                tavilyError.stack,
            );
        }

        this.logger.warn(
            `Could not find or validate a source URL for "${itemName}" after all attempts.`,
        );

        return undefined;
    }

    private async webSearch(query: string, config?: Partial<ConfigDto>) {
        return this.searchService.webSearch(query, config);
    }

    /**
     * Use AI to validate if a URL is the official/canonical source for an item
     */
    private async validateUrlWithAI(
        itemName: string,
        itemDescription: string,
        candidateUrl: string,
    ): Promise<{ isOfficial: boolean; confidence: number; reasoning: string } | null> {
        if (!this.aiService.isAiConfigured()) {
            this.logger.warn('AI service not configured, skipping AI URL validation');
            return null;
        }

        try {
            // Extract content from the URL using Tavily
            let pageContent = '';
            try {
                const extractedContent = await this.searchService.extractContent(candidateUrl);
                pageContent = extractedContent.rawContent || '';
            } catch (contentError) {
                this.logger.warn(
                    `Could not extract content from ${candidateUrl}: ${contentError.message}`,
                );
                // Continue with empty content - AI can still analyze the URL structure
            }

            // Use AI to validate the URL
            const promptTemplate = HumanMessagePromptTemplate.fromTemplate(URL_VALIDATION_PROMPT);
            const result = await promptTemplate
                .pipe(this.llm.withStructuredOutput(urlValidationSchema))
                .invoke({
                    itemName,
                    itemDescription,
                    candidateUrl,
                    pageContent: pageContent.slice(0, 2000), // Limit content length
                });

            this.logger.log(
                `AI URL validation for "${itemName}" -> ${candidateUrl}: official=${result.is_official}, confidence=${result.confidence_score}, type=${result.url_type}`,
            );

            return {
                isOfficial: result.is_official && result.is_relevant,
                confidence: result.confidence_score,
                reasoning: result.reasoning,
            };
        } catch (error) {
            this.logger.error(
                `Error during AI URL validation for "${itemName}": ${error.message}`,
                error.stack,
            );
            return null;
        }
    }

    /**
     * Generate better search queries for finding official sources
     */
    private generateOfficialSourceQueries(itemName: string, itemDescription: string): string[] {
        const queries = [];

        // Primary query - official site
        queries.push(`"${itemName}" official website`);

        // GitHub repository query
        queries.push(`"${itemName}" github repository`);

        // Documentation query
        queries.push(`"${itemName}" documentation`);

        // If description contains keywords, use them
        const descriptionLower = itemDescription.toLowerCase();
        if (descriptionLower.includes('library') || descriptionLower.includes('framework')) {
            queries.push(`"${itemName}" library official`);
        }
        if (descriptionLower.includes('tool') || descriptionLower.includes('software')) {
            queries.push(`"${itemName}" tool official site`);
        }

        return queries;
    }

    /**
     * Check if a URL is a Google search URL that should be ignored
     */
    private isGoogleSearchUrl(url: string): boolean {
        if (!url || typeof url !== 'string') {
            return false;
        }

        // Regex pattern to match Google search URLs across all domains
        // Matches: google.{tld}/search or google.co.{tld}/search or google.com.{tld}/search
        const googleSearchRegex = /google\.(?:com?\.)?[a-z]{2,3}\/search/i;

        return googleSearchRegex.test(url);
    }
}

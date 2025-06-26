import { Injectable, Logger } from '@nestjs/common';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { SearchService, NotionService } from '../shared';

@Injectable()
export class WebPageRetrievalService {
    private readonly logger = new Logger(WebPageRetrievalService.name);
    private readonly BATCH_SIZE = 10;

    constructor(
        private readonly searchService: SearchService,
        private readonly notionService: NotionService,
    ) {}

    async retrieveWebPages(
        slug: string,
        searchQueries: string[],
        processedSourceUrls: Set<string>,
        config: Required<ConfigDto>,
    ): Promise<WebPageData[]> {
        const allFetchedPages: WebPageData[] = [];
        const currentRunProcessedUrls = new Set<string>();

        this.logger.log(`[${slug}] Executing ${searchQueries.length} search queries`);

        const queriesToProcess = searchQueries.slice(0, config.max_search_queries);

        // Create an array of search promises
        const searchPromises = queriesToProcess.map(async (query) => {
            try {
                const documents = await this.webSearch(query, config);
                this.logger.log(
                    `[${slug}] Found ${documents.length} results for query: "${query}"`,
                );
                return { query, documents, success: true };
            } catch (error) {
                this.logger.error(
                    `[${slug}] Error executing search query "${query}": ${error.message}`,
                );
                return { query, documents: [], success: false };
            }
        });

        const searchResults = await Promise.all(searchPromises);

        // Process all search results and extract unique URLs to fetch
        const urlsToFetch: Array<{ url: string; query: string; doc: any }> = [];

        for (const result of searchResults) {
            if (!result.success || !result.documents.length) {
                continue;
            }

            // Get the top N results based on config
            const topResults = result.documents.slice(0, config.max_results_per_query);

            for (const doc of topResults) {
                const source_url = doc.url;

                // Skip invalid URLs
                if (!source_url || typeof source_url !== 'string') {
                    this.logger.warn(
                        `[${slug}] Skipping document with missing or invalid source URL for query "${result.query}". Metadata: ${JSON.stringify(doc)}`,
                    );
                    continue;
                }

                // Skip already processed URLs
                if (
                    processedSourceUrls.has(source_url) ||
                    currentRunProcessedUrls.has(source_url)
                ) {
                    continue;
                }

                urlsToFetch.push({ url: source_url, query: result.query, doc });
                currentRunProcessedUrls.add(source_url);
            }
        }

        this.logger.log(`[${slug}] Found ${urlsToFetch.length} unique URLs to fetch content from`);

        // Limit the number of URLs to process based on config
        const urlsToProcess = urlsToFetch.slice(0, config.max_pages_to_process);

        for (let i = 0; i < urlsToProcess.length; i += this.BATCH_SIZE) {
            const batch = urlsToProcess.slice(i, i + this.BATCH_SIZE);

            const extractionPromises = batch.map(async ({ url, query }) => {
                try {
                    const response = await this.searchService.extractContent(url);

                    if (!response.rawContent) {
                        this.logger.warn(
                            `[${slug}] Skipping document with missing extraction results for query "${query}". URL: ${url}`,
                        );
                        return null;
                    }

                    return {
                        source_url: url,
                        raw_content: response.rawContent,
                        retrieved_at: new Date().toISOString(),
                    };
                } catch (error) {
                    this.logger.error(
                        `[${slug}] Error fetching content from ${url}: ${error.message}`,
                    );
                    return null;
                }
            });

            const batchResults = await Promise.all(extractionPromises);

            const validResults: WebPageData[] = batchResults.filter((result) => result !== null);

            allFetchedPages.push(...validResults);

            // Add a small delay between batches to be polite to the API
            if (i + this.BATCH_SIZE < urlsToProcess.length) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        this.logger.log(
            `[${slug}] Web page retrieval complete. Retrieved ${allFetchedPages.length} pages.`,
        );

        return allFetchedPages;
    }

    /**
     * Retrieve web pages from specific URLs
     * @param slug The slug for logging purposes
     * @param urls The URLs to retrieve content from
     * @param processedSourceUrls Set of already processed URLs
     * @returns Array of web page data
     */
    async retrieveSpecificUrls(
        slug: string,
        urls: string[],
        processedSourceUrls: Set<string>,
    ): Promise<WebPageData[]> {
        const dedupedUrls = [...new Set(urls)];
        const allFetchedPages: WebPageData[] = [];

        if (dedupedUrls.length === 0) {
            this.logger.log(`[${slug}] All URLs have already been processed. Skipping.`);
            return [];
        }

        // Separate Notion URLs from regular URLs
        const notionUrls: string[] = [];
        const regularUrls: string[] = [];

        for (const url of dedupedUrls) {
            if (this.notionService.isNotionUrl(url)) {
                notionUrls.push(url);
            } else {
                regularUrls.push(url);
            }
        }

        this.logger.log(
            `[${slug}] Processing ${dedupedUrls.length} URLs: ${notionUrls.length} Notion URLs, ${regularUrls.length} regular URLs`,
        );

        // Process Notion URLs
        if (notionUrls.length > 0) {
            this.logger.log(`[${slug}] Processing ${notionUrls.length} Notion URLs`);

            for (const url of notionUrls) {
                try {
                    const content = await this.notionService.extractNotionContent(url);

                    // Add to processed URLs set
                    processedSourceUrls.add(url);

                    allFetchedPages.push({
                        source_url: url,
                        raw_content: content,
                        retrieved_at: new Date().toISOString(),
                    });

                    this.logger.log(
                        `[${slug}] Successfully extracted content from Notion URL: ${url}`,
                    );
                } catch (error) {
                    this.logger.error(
                        `[${slug}] Error extracting content from Notion URL ${url}: ${error.message}`,
                    );
                }
            }
        }

        // Process regular URLs
        if (regularUrls.length > 0) {
            this.logger.log(`[${slug}] Processing ${regularUrls.length} regular URLs`);
            const tavilyResults = await this.processUrls(slug, regularUrls, processedSourceUrls);
            allFetchedPages.push(...tavilyResults);
        }

        this.logger.log(
            `[${slug}] Specific URL retrieval complete. Retrieved ${allFetchedPages.length} pages.`,
        );

        return allFetchedPages;
    }

    /**
     * Process URLs using Tavily (extracted from original retrieveSpecificUrls method)
     */
    private async processUrls(
        slug: string,
        urls: string[],
        processedSourceUrls: Set<string>,
    ): Promise<WebPageData[]> {
        const allFetchedPages: WebPageData[] = [];

        this.logger.log(`[${slug}] Processing ${urls.length} URLs`);

        for (let i = 0; i < urls.length; i += this.BATCH_SIZE) {
            const batch = urls.slice(i, i + this.BATCH_SIZE);

            const extractionPromises = batch.map(async (url: string) => {
                try {
                    const response = await this.searchService.extractContent(url);

                    if (!response.rawContent) {
                        this.logger.warn(
                            `[${slug}] Skipping URL with missing extraction results: ${url}`,
                        );
                        return null;
                    }

                    // Add to processed URLs set
                    processedSourceUrls.add(url);

                    return {
                        source_url: url,
                        raw_content: response.rawContent,
                        retrieved_at: new Date().toISOString(),
                    };
                } catch (error: any) {
                    this.logger.error(
                        `[${slug}] Error fetching content from ${url}: ${error.message}`,
                    );
                    return null;
                }
            });

            const batchResults = await Promise.all(extractionPromises);
            const validResults: WebPageData[] = batchResults.filter(
                (result: WebPageData | null) => result !== null,
            ) as WebPageData[];

            allFetchedPages.push(...validResults);

            // Add a small delay between batches to be polite to the API
            if (i + this.BATCH_SIZE < urls.length) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        return allFetchedPages;
    }

    async webSearch(query: string, config?: ConfigDto) {
        return this.searchService.webSearch(query, config);
    }
}

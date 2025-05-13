import { Injectable, Logger } from '@nestjs/common';
import { TavilyClient } from '@tavily/core';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';
import { SearchService } from '../shared';

@Injectable()
export class WebPageRetrievalService {
  private readonly logger = new Logger(WebPageRetrievalService.name);
  private tavilyClient: TavilyClient | undefined;

  constructor(private readonly searchService: SearchService) {
    this.tavilyClient = this.searchService.getTavilyClient();
  }

  async retrieveWebPages(
    slug: string,
    searchQueries: string[],
    processedSourceUrls: Set<string>,
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

    this.logger.log(
      `[${slug}] Executing ${searchQueries.length} search queries`,
    );

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
          `[${slug}] Error executing search query "${query}" with Tavily: ${error.message}`,
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
      const topResults = result.documents.slice(
        0,
        config.max_results_per_query,
      );

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

    this.logger.log(
      `[${slug}] Found ${urlsToFetch.length} unique URLs to fetch content from`,
    );

    // Limit the number of URLs to process based on config
    const urlsToProcess = urlsToFetch.slice(0, config.max_pages_to_process);

    // Process URLs in batches to avoid overwhelming the API
    const BATCH_SIZE = 15;

    for (let i = 0; i < urlsToProcess.length; i += BATCH_SIZE) {
      const batch = urlsToProcess.slice(i, i + BATCH_SIZE);

      const extractionPromises = batch.map(async ({ url, query }) => {
        try {
          const response = await this.tavilyClient.extract([url], {
            maxResults: 1,
          });

          if (!response.results[0]) {
            this.logger.warn(
              `[${slug}] Skipping document with missing extraction results for query "${query}". URL: ${url}`,
            );
            return null;
          }

          const extractedResult = response.results[0];

          return {
            source_url: url,
            raw_content: extractedResult.rawContent,
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

      const validResults: WebPageData[] = batchResults.filter(
        (result) => result !== null,
      );

      allFetchedPages.push(...validResults);

      // Add a small delay between batches to be polite to the API
      if (i + BATCH_SIZE < urlsToProcess.length) {
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
    if (!this.tavilyClient) {
      this.logger.warn(
        `[${slug}] Tavily API key not configured. Skipping specific URL retrieval.`,
      );
      return [];
    }

    if (!urls || urls.length === 0) {
      return [];
    }

    this.logger.log(
      `[${slug}] Retrieving content from ${urls.length} specific URLs`,
    );

    const allFetchedPages: WebPageData[] = [];

    if (urls.length === 0) {
      this.logger.log(
        `[${slug}] All URLs have already been processed. Skipping.`,
      );
      return [];
    }

    this.logger.log(`[${slug}] Processing ${urls.length} unique URLs`);

    // Process URLs in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;

    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const batch = urls.slice(i, i + BATCH_SIZE);

      const extractionPromises = batch.map(async (url) => {
        try {
          const response = await this.tavilyClient.extract([url], {
            maxResults: 1,
          });

          if (!response.results[0]) {
            this.logger.warn(
              `[${slug}] Skipping URL with missing extraction results: ${url}`,
            );
            return null;
          }

          const extractedResult = response.results[0];

          // Add to processed URLs set
          processedSourceUrls.add(url);

          return {
            source_url: url,
            raw_content: extractedResult.rawContent,
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
      const validResults: WebPageData[] = batchResults.filter(
        (result) => result !== null,
      );

      allFetchedPages.push(...validResults);

      // Add a small delay between batches to be polite to the API
      if (i + BATCH_SIZE < urls.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    this.logger.log(
      `[${slug}] Specific URL retrieval complete. Retrieved ${allFetchedPages.length} pages.`,
    );

    return allFetchedPages;
  }

  async webSearch(query: string, config?: ConfigDto) {
    return this.searchService.webSearch(query, config);
  }
}

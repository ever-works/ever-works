import { Injectable, Logger } from '@nestjs/common';
import { tavily, TavilyClient } from '@tavily/core';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData } from '../interfaces/items-generator.interfaces';

@Injectable()
export class WebPageRetrievalService {
  private readonly logger = new Logger(WebPageRetrievalService.name);
  private tavilyClient: TavilyClient | undefined;

  constructor() {
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

            const response = await this.tavilyClient.extract([source_url], {
              maxResults: 1,
            });

            if (!response.results[0]) {
              this.logger.warn(
                `[${slug}] Skipping document with missing or invalid source URL for query "${query}". Metadata: ${JSON.stringify(doc)}`,
              );
              continue;
            }

            const extractedResult = response.results[0];

            allFetchedPages.push({
              source_url,
              raw_content: extractedResult.rawContent,
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

  async webSearch(query: string, config?: ConfigDto) {
    if (!this.tavilyClient) {
      return [];
    }
    
    const DEFAULT_MAX_RESULTS = 20;
    
    const searches = await this.tavilyClient.search(query, {
      maxResults: config?.max_results_per_query || DEFAULT_MAX_RESULTS,
    });

    return searches.results.sort((a, b) => b.score - a.score);
  }
}

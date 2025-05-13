import { Injectable, Logger } from '@nestjs/common';
import { tavily, TavilyClient } from '@tavily/core';
import { ConfigDto } from '../dto/create-items-generator.dto';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly tavilyClient: TavilyClient | undefined;
  private readonly isConfigured: boolean;

  constructor() {
    this.isConfigured = !!process.env.TAVILY_API_KEY;
    
    if (!this.isConfigured) {
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
   * Get the Tavily client instance
   */
  getTavilyClient(): TavilyClient | undefined {
    return this.tavilyClient;
  }

  /**
   * Check if the search service is properly configured
   */
  isSearchConfigured(): boolean {
    return this.isConfigured;
  }

  /**
   * Perform a web search using Tavily
   * @param query The search query
   * @param config Optional configuration
   */
  async webSearch(query: string, config?: Partial<ConfigDto>) {
    if (!this.tavilyClient) {
      return [];
    }
    
    const DEFAULT_MAX_RESULTS = 20;
    
    const searches = await this.tavilyClient.search(query, {
      maxResults: config?.max_results_per_query || DEFAULT_MAX_RESULTS,
    });

    return searches.results.sort((a, b) => b.score - a.score);
  }

  /**
   * Extract content from a URL using Tavily
   * @param url The URL to extract content from
   */
  async extractContent(url: string) {
    if (!this.tavilyClient) {
      throw new Error('Tavily client not configured');
    }

    const response = await this.tavilyClient.extract([url], {
      maxResults: 1,
    });

    if (!response.results[0]) {
      throw new Error(`Failed to extract content from ${url}`);
    }

    return response.results[0];
  }
}

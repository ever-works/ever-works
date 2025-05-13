import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { tavily, TavilyClient } from '@tavily/core';
import { ItemData } from '../../agent/types';
import { ConfigDto } from '../dto/create-items-generator.dto';

@Injectable()
export class SourceValidationService {
  private readonly logger = new Logger(SourceValidationService.name);
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

  async filterAndValidateSourceItems(
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

      const searchQuery = (
        safeItemName +
        `${safeItemName && safeItemDescription ? ' - ' : ''}` +
        safeItemDescription
      ).trim();

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

  private async webSearch(query: string, config?: Partial<ConfigDto>) {
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

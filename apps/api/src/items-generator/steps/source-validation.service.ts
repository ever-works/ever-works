import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TavilyClient } from '@tavily/core';
import { ItemData, ConfigDto } from '../dto';
import { SearchService } from '../shared';

@Injectable()
export class SourceValidationService {
  private readonly logger = new Logger(SourceValidationService.name);
  private tavilyClient: TavilyClient | undefined;

  constructor(private readonly searchService: SearchService) {
    this.tavilyClient = this.searchService.getTavilyClient();
  }

  async filterAndValidateSourceItems(
    items: ItemData[],
    slug: string,
  ): Promise<ItemData[]> {
    this.logger.log(
      `[${slug}] Starting source URL validation and filtering for ${items.length} items.`,
    );

    if (!items || items.length === 0) {
      this.logger.log(`[${slug}] No items to validate.`);
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
          `[${slug}] Processing batch ${batchNumber} of ${totalBatches} (${batch.length} items)`,
        );

        // Process all items in the batch in parallel
        const validationPromises = batch.map((item) => {
          return this.validateAndFetchSourceUrl(slug, item)
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
                `[${slug}] Error validating URL for "${item.name}": ${error.message}`,
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
          `[${slug}] Batch ${batchNumber} complete. ${validBatchItems.length} of ${batch.length} items passed validation.`,
        );

        // Add a small delay between batches to be polite to external servers
        if (i + BATCH_SIZE < items.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      this.logger.error(
        `[${slug}] Error during source URL validation: ${error.message}`,
        error.stack,
      );
    }

    const processingTime = (Date.now() - startTime) / 1000;
    this.logger.log(
      `[${slug}] Finished source URL validation in ${processingTime.toFixed(2)}s. ${validItems.length} of ${items.length} items passed.`,
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
        // Basic syntax check
        try {
          new URL(urlToValidate);
        } catch (urlError) {
          this.logger.warn(
            `[${slug}] Invalid URL format for "${itemName}": ${urlToValidate}`,
          );
          return undefined;
        }

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

    // Try to validate the original source URL first
    const validatedInitialUrl = await validateUrl(sourceUrl);
    if (validatedInitialUrl) {
      return validatedInitialUrl;
    }

    // If original URL is invalid, try to find a new one using Tavily
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
        max_results_per_query: 5,
      });

      if (documents && documents.length > 0) {
        // Filter out undefined URLs and prepare for validation
        const urlsToValidate = documents
          .filter((doc) => doc.url && typeof doc.url === 'string')
          .map((doc) => doc.url);

        if (urlsToValidate.length === 0) {
          this.logger.warn(
            `[${slug}] Tavily search found no valid URLs for "${itemName}".`,
          );
          return undefined;
        }

        this.logger.log(
          `[${slug}] Validating ${urlsToValidate.length} URLs from Tavily search for "${itemName}".`,
        );

        // Validate all URLs in parallel
        const validationPromises = urlsToValidate.map((url) =>
          validateUrl(url),
        );
        const validationResults = await Promise.all(validationPromises);

        // Find the first valid URL
        const firstValidUrl = validationResults.find(
          (url) => url !== undefined,
        );

        if (firstValidUrl) {
          return firstValidUrl;
        }

        this.logger.warn(
          `[${slug}] Tavily found ${urlsToValidate.length} URLs for "${itemName}", but none passed validation.`,
        );
      }
    } catch (tavilyError) {
      this.logger.error(
        `[${slug}] Error during Tavily search for "${itemName}": ${tavilyError.message}`,
        tavilyError.stack,
      );
    }

    this.logger.warn(
      `[${slug}] Could not find or validate a source URL for "${itemName}" after all attempts.`,
    );

    return undefined;
  }

  private async webSearch(query: string, config?: Partial<ConfigDto>) {
    return this.searchService.webSearch(query, config);
  }
}

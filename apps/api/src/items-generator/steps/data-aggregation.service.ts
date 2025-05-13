import { Injectable, Logger } from '@nestjs/common';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { ItemsGeneratorMetrics } from '../dto/items-generator-response.dto';
import { ItemData } from '../../agent/types';
import { deduplicateByField } from '../../agent/utils';
import { deduplicate, extractNewItems } from '../../agent/deduplicator';

@Injectable()
export class DataAggregationService {
  private readonly logger = new Logger(DataAggregationService.name);

  async aggregateAndDeduplicateData(
    createItemsGeneratorDto: CreateItemsGeneratorDto,
    existingItems: ItemData[],
    newlyExtractedItemsThisRun: ItemData[],
    urlsScannedThisRun: number,
    pagesProcessedThisRun: number,
  ) {
    const { slug, description } = createItemsGeneratorDto;

    this.logger.log(`[${slug}] Starting data aggregation and deduplication.`);
    let newItemsAddedToStoreCount = 0;

    // deduplicate newly extracted items (by fields)
    this.logger.log(`[${slug}] Deduplicating items by fields`);
    let deduplicated = deduplicateByField(
      deduplicateByField(newlyExtractedItemsThisRun, 'slug'),
      'source_url',
    );

    // deduplicate newly extracted items (with AI)
    this.logger.log(`[${slug}] Deduplicating items with AI.`);
    deduplicated = await deduplicate(
      description,
      deduplicated.map((i) => ({
        name: i.name,
        description: i.description,
        url: i.source_url,
      })),
    );

    let aggregatedItems = deduplicated;
    if (existingItems.length > 0) {
      this.logger.log(`[${slug}] Extracting new items.`);
      aggregatedItems = await extractNewItems(existingItems, deduplicated);
    }

    const metrics: ItemsGeneratorMetrics = {
      urls_scanned: urlsScannedThisRun,
      pages_processed: pagesProcessedThisRun,
      items_extracted_current_run: newlyExtractedItemsThisRun.length,
      new_items_added_to_store: newItemsAddedToStoreCount,
      total_items_in_store: aggregatedItems.length,
    };

    return { aggregatedItems, metrics };
  }
}

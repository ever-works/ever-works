import { Module } from '@nestjs/common';
import { ItemsGeneratorService } from './items-generator.service';
import { ItemSubmissionService } from './item-submission.service';
import { AiItemGenerationService } from './steps/ai-item-generation.service';
import { SearchQueryGenerationService } from './steps/search-query-generation.service';
import { WebPageRetrievalService } from './steps/web-page-retrieval.service';
import { ContentFilteringService } from './steps/content-filtering.service';
import { ItemExtractionService } from './steps/item-extraction.service';
import { SourceValidationService } from './steps/source-validation.service';
import { DataAggregationService } from './steps/data-aggregation.service';
import { CategoryProcessingService } from './steps/category-processing.service';
import { MarkdownGenerationService } from './steps/markdown-generation.service';
import { PromptProcessingService } from './steps/prompt-processing.service';
import { PromptComparisonService } from './steps/prompt-comparison.service';
import { AiService, SearchService, NotionService } from './shared';
import {
  SharedUtilsService,
  NewItemsExtractorService,
  AiDeduplicatorService
} from './steps/data-aggregation';

@Module({
  providers: [
    // Shared services
    AiService,
    SearchService,
    NotionService,

    // Data aggregation shared services
    SharedUtilsService,
    NewItemsExtractorService,
    AiDeduplicatorService,

    // Main service
    ItemsGeneratorService,
    ItemSubmissionService,

    // Step services
    PromptComparisonService,
    PromptProcessingService,
    AiItemGenerationService,
    SearchQueryGenerationService,
    WebPageRetrievalService,
    ContentFilteringService,
    ItemExtractionService,
    SourceValidationService,
    DataAggregationService,
    CategoryProcessingService,
    MarkdownGenerationService,
  ],
  exports: [ItemsGeneratorService, ItemSubmissionService],
})
export class ItemsGeneratorModule {}

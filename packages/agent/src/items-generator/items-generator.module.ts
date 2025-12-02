import { Module } from '@nestjs/common';
import { ItemsGeneratorService } from './items-generator.service';
import { ItemSubmissionService } from './item-submission.service';
import { AiItemGenerationService } from './steps/ai-item-generation.service';
import { SearchQueryGenerationService } from './steps/search-query-generation.service';
import { WebPageRetrievalService } from './steps/web-page-retrieval.service';
import { ContentFilteringService } from './steps/content-filtering.service';
import { ContentPrefilterService } from './steps/content-prefilter.service';
import { ItemExtractionService } from './steps/item-extraction.service';
import { SourceValidationService } from './steps/source-validation.service';
import { DataAggregationService } from './steps/data-aggregation.service';
import { CategoryProcessingService } from './steps/category-processing.service';
import { MarkdownGenerationService } from './steps/markdown-generation.service';
import { PromptProcessingService } from './steps/prompt-processing.service';
import { PromptComparisonService } from './steps/prompt-comparison.service';
import { BadgeProcessingService } from './steps/badge-processing.service';
import { DomainDetectionService } from './steps/domain-detection.service';
import { SearchService, NotionService, BadgeEvaluationService } from './shared';
import { SemanticChunker } from './utils/semantic-chunker';
import {
    SharedUtilsService,
    NewItemsExtractorService,
    AiDeduplicatorService,
} from './steps/data-aggregation';
import { AiModule } from '../ai';
import { GitModule } from '../git';
import { UrlPrefilter } from './utils/url-prefilter';

export const STEP_SERVICES = [
    // Shared services
    SearchService,
    NotionService,
    BadgeEvaluationService,
    SemanticChunker,

    // Data aggregation shared services
    SharedUtilsService,
    NewItemsExtractorService,
    AiDeduplicatorService,

    // Utils
    UrlPrefilter,

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
    ContentPrefilterService,
    ItemExtractionService,
    SourceValidationService,
    DataAggregationService,
    CategoryProcessingService,
    MarkdownGenerationService,
    BadgeProcessingService,
    DomainDetectionService,
];

export const STEP_SERVICES_EXPORTS = [ItemsGeneratorService, ItemSubmissionService];

@Module({
    imports: [AiModule, GitModule],
    providers: STEP_SERVICES,
    exports: STEP_SERVICES_EXPORTS,
})
export class ItemsGeneratorModule {}

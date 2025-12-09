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
import { BadgeProcessingService } from './steps/badge-processing.service';
import { DomainDetectionService } from './steps/domain-detection.service';
import { SearchService, NotionService, BadgeEvaluationService } from './shared';
import {
    SharedUtilsService,
    NewItemsExtractorService,
    AiDeduplicatorService,
} from './steps/data-aggregation';
import { AiModule } from '../ai';
import { GitModule } from '../git';
import { PipelineExecutor } from './pipeline/pipeline-executor';

export const STEP_SERVICES = [
    // Shared services
    SearchService,
    NotionService,
    BadgeEvaluationService,
    PipelineExecutor, // This has a `CacheDependency`; do not import `CacheManager` here.
    // It should be called by the consumer of this agent.

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
    DomainDetectionService,
    AiItemGenerationService,
    SearchQueryGenerationService,
    WebPageRetrievalService,
    ContentFilteringService,
    ItemExtractionService,
    SourceValidationService,
    DataAggregationService,
    CategoryProcessingService,
    MarkdownGenerationService,
    BadgeProcessingService,
];

export const STEP_SERVICES_EXPORTS = [ItemsGeneratorService, ItemSubmissionService];

@Module({
    imports: [AiModule, GitModule],
    providers: STEP_SERVICES,
    exports: STEP_SERVICES_EXPORTS,
})
export class ItemsGeneratorModule {}

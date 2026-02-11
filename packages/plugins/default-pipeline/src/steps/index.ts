/**
 * Default Pipeline Steps
 *
 * All built-in step implementations for the default generation pipeline.
 * These steps use StepExecutionContext for accessing AI, Search, and
 * Screenshot services through the plugin system facades.
 */

// Core Steps (Transformed)
export { PromptComparisonStep } from './prompt-comparison.step.js';
export { PromptProcessingStep } from './prompt-processing.step.js';
export { DomainDetectionStep } from './domain-detection.step.js';

// Content Generation Steps (Transformed)
export { AiItemGenerationStep } from './ai-item-generation.step.js';
export { SearchQueryGenerationStep } from './search-query-generation.step.js';

// Web Retrieval Steps (Transformed)
export { WebSearchStep } from './web-search.step.js';
export { ContentRetrievalStep } from './content-retrieval.step.js';
export { ContentFilteringStep } from './content-filtering.step.js';
export { ItemExtractionStep } from './item-extraction.step.js';
export { DataAggregationStep } from './data-aggregation.step.js';
export { CategoryProcessingStep } from './category-processing.step.js';
export { SourceValidationStep } from './source-validation.step.js';
export { BadgeProcessingStep } from './badge-processing.step.js';
export { ImageCaptureStep } from './image-capture.step.js';
export { MarkdownGenerationStep } from './markdown-generation.step.js';

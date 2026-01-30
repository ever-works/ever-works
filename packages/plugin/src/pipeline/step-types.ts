import type { ItemData, Category, Tag, Brand, DomainAnalysis, WebPageData } from '@ever-works/contracts';

/**
 * Built-in pipeline step identifiers
 * Based on the existing ItemsGeneratorStep enum
 */
export type BuiltInStepId =
	| 'prompt-comparison'
	| 'prompt-processing'
	| 'domain-detection'
	| 'ai-first-items-generation'
	| 'search-queries-generation'
	| 'web-search'
	| 'content-retrieval'
	| 'content-filtering'
	| 'items-extraction'
	| 'deduplication-and-data-aggregation'
	| 'categories-tags-processing'
	| 'sources-validation'
	| 'badges-processing'
	| 'image-capture'
	| 'markdown-generation';

/**
 * Keys for data stored in the pipeline context
 */
export type StepDataKey =
	| 'extractedUrls'
	| 'searchQueries'
	| 'webPages'
	| 'processedSourceUrls'
	| 'contentCache'
	| 'initialAiItems'
	| 'extractedWebItems'
	| 'aggregatedItems'
	| 'finalItems'
	| 'finalCategories'
	| 'finalTags'
	| 'finalBrands'
	| 'domainAnalysis'
	| 'metrics'
	| 'allInitialCategories'
	| 'allPriorityCategories'
	| 'featuredItemHints'
	| 'subject'
	| 'shouldStop';

/**
 * Type mapping for step data keys
 */
export interface StepDataTypes {
	extractedUrls: string[];
	searchQueries: string[];
	webPages: WebPageData[];
	processedSourceUrls: Set<string>;
	contentCache: Map<string, string>;
	initialAiItems: ItemData[];
	extractedWebItems: ItemData[];
	aggregatedItems: ItemData[];
	finalItems: ItemData[];
	finalCategories: Category[];
	finalTags: Tag[];
	finalBrands: Brand[];
	domainAnalysis?: DomainAnalysis;
	metrics: PipelineMetrics;
	allInitialCategories: string[];
	allPriorityCategories: string[];
	featuredItemHints: string[];
	subject?: string;
	shouldStop?: boolean;
}

/**
 * Pipeline execution metrics.
 * Mutable during pipeline execution to allow step metrics accumulation.
 */
export interface PipelineMetrics {
	startTime: number;
	duration?: number;
	itemsProcessed: number;
	urlsExtracted: number;
	pagesRetrieved: number;
	itemsExtracted: number;
	itemsAfterDedup: number;
	steps: Record<string, StepMetrics>;
}

/**
 * Metrics for a single pipeline step.
 * Mutable to allow updating during step execution.
 */
export interface StepMetrics {
	name: string;
	startTime: number;
	duration?: number;
	success: boolean;
	error?: string;
	custom?: Record<string, unknown>;
}

/**
 * Step execution status
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepResult {
	readonly status: StepStatus;
	readonly metrics?: StepMetrics;
	readonly error?: Error | string;
	readonly continue: boolean;
}

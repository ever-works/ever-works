import type { ItemData, Category, Tag, Brand, DomainAnalysis, WebPageData, PipelineMetrics } from '@ever-works/plugin';

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
	| 'shouldStop'
	| 'warnings';

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
	metrics: StandardPipelineMetrics;
	allInitialCategories: string[];
	allPriorityCategories: string[];
	featuredItemHints: string[];
	subject?: string;
	shouldStop?: boolean;
	warnings: string[];
}

export interface StandardPipelineMetrics extends PipelineMetrics {
	urlsExtracted: number;
	pagesRetrieved: number;
	itemsExtracted: number;
	itemsAfterDedup: number;
}

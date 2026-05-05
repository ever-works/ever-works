import type {
	MutableItemData,
	Category,
	Collection,
	Tag,
	Brand,
	DomainAnalysis,
	WebPageData,
	PipelineMetrics,
	ReferenceEntry
} from '@ever-works/plugin';

export type StepDataKey =
	| 'extractedUrls'
	| 'searchQueries'
	| 'webPages'
	| 'processedSourceUrls'
	| 'processedReferences'
	| 'contentCache'
	| 'initialAiItems'
	| 'extractedWebItems'
	| 'aggregatedItems'
	| 'finalItems'
	| 'finalCategories'
	| 'finalTags'
	| 'finalCollections'
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
	processedReferences: ReferenceEntry[];
	contentCache: Map<string, string>;
	initialAiItems: MutableItemData[];
	extractedWebItems: MutableItemData[];
	aggregatedItems: MutableItemData[];
	finalItems: MutableItemData[];
	finalCategories: Category[];
	finalTags: Tag[];
	finalCollections: Collection[];
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

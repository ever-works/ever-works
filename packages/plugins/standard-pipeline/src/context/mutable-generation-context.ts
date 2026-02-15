import type {
	ItemData,
	Category,
	Tag,
	Brand,
	MutableItemData,
	DomainAnalysis,
	WebPageData,
	IPipelineContext,
	DirectoryReference,
	GenerationRequest,
	ExistingItems
} from '@ever-works/plugin';
import type { StandardPipelineMetrics } from './step-data-types.js';

export interface AdvancedPromptsContext {
	readonly relevanceAssessment?: string | null;
	readonly itemGeneration?: string | null;
	readonly itemExtraction?: string | null;
	readonly searchQuery?: string | null;
	readonly categorization?: string | null;
	readonly deduplication?: string | null;
	readonly sourceValidation?: string | null;
}

export interface MutableGenerationContext extends IPipelineContext {
	directory: DirectoryReference;
	request: GenerationRequest;
	existing: ExistingItems;

	extractedUrls: string[];
	searchQueries: string[];
	webPages: WebPageData[];
	processedSourceUrls: Set<string>;
	contentCache: Map<string, string>;

	initialAiItems: MutableItemData[];
	extractedWebItems: MutableItemData[];
	aggregatedItems: MutableItemData[];
	finalItems: MutableItemData[];
	finalCategories: Category[];
	finalTags: Tag[];
	finalBrands: Brand[];

	domainAnalysis?: DomainAnalysis;
	metrics: StandardPipelineMetrics;

	allInitialCategories: string[];
	allPriorityCategories: string[];
	featuredItemHints: string[];
	subject?: string;

	advancedPrompts?: AdvancedPromptsContext | null;
	shouldStop?: boolean;
	warnings: string[];
	pluginConfig?: Record<string, Record<string, unknown>>;
}

export interface GenerationContextSnapshot {
	readonly directory: DirectoryReference;
	readonly request: GenerationRequest;
	readonly existing: ExistingItems;
	readonly extractedUrls: readonly string[];
	readonly searchQueries: readonly string[];
	readonly webPages: readonly WebPageData[];
	readonly processedSourceUrls: ReadonlySet<string>;
	readonly contentCache: ReadonlyMap<string, string>;
	readonly initialAiItems: readonly ItemData[];
	readonly extractedWebItems: readonly ItemData[];
	readonly aggregatedItems: readonly ItemData[];
	readonly finalItems: readonly ItemData[];
	readonly finalCategories: readonly Category[];
	readonly finalTags: readonly Tag[];
	readonly finalBrands: readonly Brand[];
	readonly domainAnalysis?: DomainAnalysis;
	readonly metrics: StandardPipelineMetrics;
	readonly allInitialCategories: readonly string[];
	readonly allPriorityCategories: readonly string[];
	readonly featuredItemHints: readonly string[];
	readonly subject?: string;
	readonly advancedPrompts?: AdvancedPromptsContext | null;
	readonly shouldStop?: boolean;
	readonly warnings: readonly string[];
	readonly pluginConfig?: Record<string, Record<string, unknown>>;
}

import type { ItemData, Category, Tag, Brand, MutableItemData } from '../common/item.types.js';
import type { DomainAnalysis, WebPageData } from '../common/domain.types.js';
import type { PipelineMetrics } from './step-types.js';

/**
 * Per-directory custom prompts that are appended to standard prompts
 */
export interface AdvancedPromptsContext {
	readonly relevanceAssessment?: string | null;
	readonly itemGeneration?: string | null;
	readonly itemExtraction?: string | null;
	readonly searchQuery?: string | null;
	readonly categorization?: string | null;
	readonly deduplication?: string | null;
	readonly sourceValidation?: string | null;
}

/**
 * Directory reference for generation context
 */
export interface DirectoryReference {
	readonly id: string;
	readonly name: string;
	readonly slug: string;
	readonly description?: string;
	readonly settings?: Record<string, unknown>;
}

/**
 * Items generation request parameters
 */
export interface GenerationRequest {
	/** Number of items to generate */
	readonly count?: number;
	/** Prompt or topic for generation */
	readonly prompt?: string;
	/** Additional search queries */
	readonly searchQueries?: readonly string[];
	/** URLs to extract items from */
	readonly urls?: readonly string[];
	/** Whether to include AI-generated items */
	readonly includeAiItems?: boolean;
	/** Whether to include web-extracted items */
	readonly includeWebItems?: boolean;
	/** Existing item names to avoid duplicates */
	readonly existingItemNames?: readonly string[];
	/** Existing category names */
	readonly existingCategoryNames?: readonly string[];
	/** Existing tag names */
	readonly existingTagNames?: readonly string[];
}

/**
 * Existing items in the directory (for deduplication)
 */
export interface ExistingItems {
	readonly items: readonly ItemData[];
	readonly categories: readonly Category[];
	readonly tags: readonly Tag[];
	readonly brands?: readonly Brand[];
}

/**
 * Mutable generation context used during pipeline execution
 */
export interface MutableGenerationContext {
	/** Directory being generated for */
	directory: DirectoryReference;
	/** Generation request parameters */
	request: GenerationRequest;
	/** Existing items in directory */
	existing: ExistingItems;

	// State accumulated during steps
	extractedUrls: string[];
	searchQueries: string[];
	webPages: WebPageData[];
	processedSourceUrls: Set<string>;

	/** Content cache: source_url -> raw_content (for reuse in markdown generation) */
	contentCache: Map<string, string>;

	initialAiItems: MutableItemData[];
	extractedWebItems: MutableItemData[];
	aggregatedItems: MutableItemData[];
	finalItems: MutableItemData[];
	finalCategories: Category[];
	finalTags: Tag[];
	finalBrands: Brand[];

	/** Domain intelligence */
	domainAnalysis?: DomainAnalysis;

	/** Pipeline metrics */
	metrics: PipelineMetrics;

	/** Internal state */
	allInitialCategories: string[];
	allPriorityCategories: string[];
	featuredItemHints: string[];
	subject?: string;

	/** Per-directory advanced prompts */
	advancedPrompts?: AdvancedPromptsContext | null;

	/** Control flag to stop pipeline */
	shouldStop?: boolean;
}

/**
 * Read-only generation context snapshot
 */
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
	readonly metrics: PipelineMetrics;
	readonly allInitialCategories: readonly string[];
	readonly allPriorityCategories: readonly string[];
	readonly featuredItemHints: readonly string[];
	readonly subject?: string;
	readonly advancedPrompts?: AdvancedPromptsContext | null;
	readonly shouldStop?: boolean;
}

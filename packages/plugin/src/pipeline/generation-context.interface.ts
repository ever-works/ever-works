import type {
	ItemData,
	Category,
	Tag,
	Brand,
	MutableItemData,
	DomainAnalysis,
	WebPageData
} from '@ever-works/contracts';
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
 * User reference for settings resolution and context.
 * Settings are resolved through the plugin system, not stored here.
 */
export interface UserReference {
	readonly id: string;
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
	readonly user?: UserReference;
}

/**
 * Items generation request parameters.
 *
 * Core fields are defined here. All plugin-specific configuration
 * (search limits, feature flags, etc.) goes in `config` and is
 * defined dynamically by the pipeline plugin via IFormSchemaProvider.
 */
export interface GenerationRequest {
	// ============================================================================
	// Core Fields (Platform-level)
	// ============================================================================

	/** Name/title for the generation (topic name) */
	readonly name?: string;

	/** Prompt or topic for generation */
	readonly prompt?: string;

	/** Generation method (create-update or recreate) */
	readonly generationMethod?: 'create-update' | 'recreate' | string;

	/** Company information */
	readonly company?: { name: string; website: string };

	// ============================================================================
	// Plugin Configuration (Dynamic)
	// ============================================================================

	/**
	 * Plugin-specific configuration.
	 *
	 * All pipeline-specific settings are passed here as an opaque object.
	 * The structure is defined dynamically by the pipeline plugin via
	 * IFormSchemaProvider.getFormFields(). The platform does not hardcode
	 * any field names - plugins are fully responsible for their own config.
	 */
	readonly config?: Record<string, unknown>;

	/**
	 * Provider overrides selected by the user in the generator form.
	 * When set, these override the default/directory-level provider for each facade.
	 */
	readonly providers?: {
		readonly ai?: string;
		readonly search?: string;
		readonly screenshot?: string;
		readonly contentExtractor?: string;
		readonly pipeline?: string | null;
	};
}

/**
 * Existing configuration with metadata from previous generation
 */
export interface ExistingConfig {
	readonly metadata?: {
		readonly initial_prompt?: string;
		readonly [key: string]: unknown;
	};
	readonly [key: string]: unknown;
}

/**
 * Existing items in the directory (for deduplication)
 */
export interface ExistingItems {
	readonly items: readonly ItemData[];
	readonly categories: readonly Category[];
	readonly tags: readonly Tag[];
	readonly brands?: readonly Brand[];
	/** Configuration from previous generation */
	readonly existingConfig?: ExistingConfig;
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

	/**
	 * Plugin configuration from GeneratorForm.
	 * Maps plugin ID to per-directory settings including 'enabled' flags.
	 *
	 * This is passed from the GeneratorForm via CreateItemsGeneratorDto
	 * and used by DataSourceFacade to determine which plugins to query.
	 *
	 * Example:
	 * ```typescript
	 * {
	 *   'apify-data-source': { enabled: true, datasetId: '5uxB4x3zYjV5S7nFd' },
	 *   'notion-extractor': { enabled: false }
	 * }
	 * ```
	 */
	pluginConfig?: Record<string, Record<string, unknown>>;
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
	readonly pluginConfig?: Record<string, Record<string, unknown>>;
}

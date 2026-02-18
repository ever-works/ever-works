import type { ItemData, Category, Collection, Tag, Brand } from '@ever-works/contracts';

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
	 * Per-plugin configuration extracted from the generator form.
	 * Maps plugin ID → plugin-specific settings (e.g., datasetId, enabled flag).
	 *
	 * Populated by GeneratorFormSchemaService.processFormConfig() which calls
	 * transformFormValues() on each data source plugin.
	 *
	 * Example:
	 * ```typescript
	 * {
	 *   'apify-data-source': { datasetId: '5uxB4x3zYjV5S7nFd' },
	 *   'notion-extractor': { enabled: true }
	 * }
	 * ```
	 */
	readonly pluginConfig?: Record<string, Record<string, unknown>>;

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
	readonly collections?: readonly Collection[];
	readonly brands?: readonly Brand[];
	/** Configuration from previous generation */
	readonly existingConfig?: ExistingConfig;
}

/**
 * Minimal pipeline context interface.
 * All pipeline-specific context types extend this.
 * The engine works with this interface only — it never accesses pipeline-specific fields.
 */
export interface IPipelineContext {
	readonly directory: DirectoryReference;
	readonly request: GenerationRequest;
	shouldStop?: boolean;
	warnings: string[];
}

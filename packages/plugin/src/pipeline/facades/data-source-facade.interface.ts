import type { MutableItemData, Category, Tag, Brand } from '@ever-works/contracts';
import type { DataSourceFilterContext } from '../../contracts/capabilities/data-source.interface.js';

/**
 * Options for querying data sources via the facade.
 */
export interface DataSourceFacadeOptions {
	/** User ID for settings resolution */
	readonly userId?: string;
	/** Directory ID for settings resolution */
	readonly directoryId?: string;
	/** Maximum number of items to return per source */
	readonly limit?: number;
	/**
	 * Plugin configuration from GeneratorForm.
	 * Maps plugin ID to per-directory settings including the 'enabled' flag.
	 *
	 * Example:
	 * ```typescript
	 * {
	 *   'apify-data-source': { enabled: true, datasetId: '5uxB4x3zYjV5S7nFd' },
	 *   'notion-extractor': { enabled: false }
	 * }
	 * ```
	 */
	readonly pluginConfig?: Record<string, Record<string, unknown>>;
	/**
	 * Context for per-plugin relevance filtering.
	 * Each data source plugin filters its own items based on this context.
	 */
	readonly filterContext?: DataSourceFilterContext;
}

/**
 * Result from querying all enabled data sources.
 */
export interface DataSourceFacadeResult {
	/** All items collected from data sources (already filtered by each plugin) */
	readonly items: MutableItemData[];
	/** Maps item slug to the source plugin ID that provided it */
	readonly sourceMap: Map<string, string>;
	/** Errors encountered while querying sources */
	readonly errors: ReadonlyArray<{ sourceId: string; error: string }>;
	/** Categories collected from data sources */
	readonly categories?: readonly Category[];
	/** Tags collected from data sources */
	readonly tags?: readonly Tag[];
	/** Brands collected from data sources */
	readonly brands?: readonly Brand[];
}

/**
 * Information about an enabled data source.
 */
export interface EnabledDataSource {
	/** Plugin ID */
	readonly id: string;
	/** Plugin display name */
	readonly name: string;
	/** Source name from the plugin */
	readonly sourceName: string;
}

/**
 * Data Source Facade interface for pipeline steps.
 *
 * Provides unified access to external data sources (Apify, etc.).
 * Each data source plugin returns items that have already been filtered
 * for relevance to the directory's prompt/domain.
 *
 * Flow:
 * 1. User enables data source plugin in GeneratorForm (checkbox)
 * 2. pluginConfig passed to facade via options
 * 3. Facade checks each plugin's enabled flag in pluginConfig
 * 4. Enabled plugins are queried with filterContext
 * 5. Each plugin filters its items based on filterContext
 * 6. Facade aggregates filtered items from all enabled sources
 *
 * @example
 * ```typescript
 * // In pipeline step
 * const result = await execContext.dataSourceFacade.queryAll({
 *     pluginConfig: context.pluginConfig,
 *     filterContext: {
 *         prompt: directory.prompt,
 *         subject: context.subject,
 *         keywords: ['AI', 'tools', 'developers']
 *     }
 * });
 *
 * // Items are already filtered by each plugin
 * const dataSourceItems = result.items;
 * ```
 */
export interface IDataSourceFacade {
	/**
	 * Query all enabled data sources and aggregate their items.
	 *
	 * Only plugins that have `enabled: true` in pluginConfig will be queried.
	 * Each plugin is responsible for filtering its items based on filterContext.
	 *
	 * @param options - Query options including pluginConfig and filterContext
	 * @returns Aggregated items from all enabled data sources
	 */
	queryAll(options?: DataSourceFacadeOptions): Promise<DataSourceFacadeResult>;

	/**
	 * Get a list of all enabled data sources for the current context.
	 *
	 * @param options - Options for resolving which sources are enabled
	 * @returns List of enabled data sources
	 */
	getEnabledSources(options?: DataSourceFacadeOptions): EnabledDataSource[];

	/**
	 * Check if any data source plugin is configured and available.
	 *
	 * @returns true if at least one data source plugin is enabled
	 */
	isConfigured(): boolean;
}

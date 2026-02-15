import type { MutableItemData, Category, Tag, Brand } from '@ever-works/contracts';
import type { DataSourceFilterContext } from '../contracts/capabilities/data-source.interface.js';
import type { IBaseFacade } from './base-facade.interface.js';

export interface DataSourceFacadeOptions {
	/** User ID for settings resolution */
	readonly userId: string;
	/** Directory ID - required for Level 2 enable check */
	readonly directoryId?: string;
	/** Maximum number of items to return per source */
	readonly limit?: number;
	/**
	 * Plugin configuration from GeneratorForm (Level 3 options).
	 * Contains per-generation settings like datasetId, maxItems, etc.
	 * Note: Enable/disable is at Level 2 (DirectoryPlugin), not here.
	 */
	readonly pluginConfig?: Record<string, Record<string, unknown>>;
	/**
	 * Context for per-plugin relevance filtering.
	 * Each data source plugin filters its own items based on this context.
	 */
	readonly filterContext?: DataSourceFilterContext;
}

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
 * Checks DirectoryPlugin.enabled (Level 2) or autoEnable in manifest.
 */
export interface IDataSourceFacade extends IBaseFacade {
	/**
	 * Query all enabled data sources and aggregate their items.
	 * Checks DirectoryPlugin.enabled or autoEnable manifest flag.
	 */
	queryAll(options: DataSourceFacadeOptions): Promise<DataSourceFacadeResult>;

	/**
	 * Get a list of all enabled data sources for a directory.
	 */
	getEnabledSources(directoryId: string, userId: string): Promise<EnabledDataSource[]>;
}

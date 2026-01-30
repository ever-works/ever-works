import type { IPlugin } from '../plugin.interface.js';
import type { ItemData, Category, Tag, Brand } from '@ever-works/contracts';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Context for filtering items by relevance to the directory's domain/prompt.
 * Each data source plugin can use this context to filter items it returns.
 */
export interface DataSourceFilterContext {
	/** Directory prompt/description */
	readonly prompt?: string;
	/** Directory subject/topic */
	readonly subject?: string;
	/** Keywords extracted from prompt (for basic keyword matching) */
	readonly keywords?: readonly string[];
}

/**
 * Data source query options
 */
export interface DataSourceQueryOptions {
	/** Search query */
	readonly query?: string;
	/** Number of items to return */
	readonly limit?: number;
	/** Offset for pagination */
	readonly offset?: number;
	/** Category filter */
	readonly category?: string;
	/** Tag filters */
	readonly tags?: readonly string[];
	/** Sort field */
	readonly sortBy?: string;
	/** Sort direction */
	readonly sortOrder?: 'asc' | 'desc';
	/** Custom filters */
	readonly filters?: Record<string, unknown>;
	/**
	 * Resolved settings for this operation.
	 * Contains plugin-specific configuration including API keys and options.
	 * Passed by the facade with user/directory-scoped settings.
	 */
	readonly settings?: PluginSettings;
	/**
	 * Context for filtering items by relevance.
	 * Plugins should filter their results to only include relevant items.
	 */
	readonly filterContext?: DataSourceFilterContext;
}

/**
 * Data source query result
 */
export interface DataSourceQueryResult {
	/** Retrieved items */
	readonly items: readonly ItemData[];
	/** Total count (for pagination) */
	readonly total?: number;
	/** Whether there are more items */
	readonly hasMore: boolean;
	/** Categories from the data source */
	readonly categories?: readonly Category[];
	/** Tags from the data source */
	readonly tags?: readonly Tag[];
	/** Brands from the data source */
	readonly brands?: readonly Brand[];
}

/**
 * Data source sync status
 */
export type DataSourceSyncStatus = 'idle' | 'syncing' | 'completed' | 'failed';

/**
 * Data source sync result
 */
export interface DataSourceSyncResult {
	/** Sync status */
	readonly status: DataSourceSyncStatus;
	/** Items added */
	readonly itemsAdded: number;
	/** Items updated */
	readonly itemsUpdated: number;
	/** Items removed */
	readonly itemsRemoved: number;
	/** Sync duration in ms */
	readonly duration: number;
	/** Error message if failed */
	readonly error?: string;
	/** Last sync timestamp */
	readonly syncedAt: string;
}

/**
 * Data source metadata
 */
export interface DataSourceMetadata {
	/** Data source name */
	readonly name: string;
	/** Data source description */
	readonly description?: string;
	/** Total items available */
	readonly totalItems?: number;
	/** Available categories */
	readonly categories?: readonly string[];
	/** Available tags */
	readonly tags?: readonly string[];
	/** Last updated timestamp */
	readonly lastUpdated?: string;
	/** Data source URL */
	readonly sourceUrl?: string;
}

/**
 * Data source plugin interface
 * Capability: 'data-source'
 */
export interface IDataSourcePlugin extends IPlugin {
	/** Data source name/identifier */
	readonly sourceName: string;

	/**
	 * Query items from the data source
	 */
	query(options?: DataSourceQueryOptions): Promise<DataSourceQueryResult>;

	/**
	 * Get a single item by ID or URL
	 */
	getItem?(id: string): Promise<ItemData | null>;

	/**
	 * Sync data from the source
	 */
	sync?(): Promise<DataSourceSyncResult>;

	/**
	 * Get data source metadata
	 */
	getMetadata?(): Promise<DataSourceMetadata>;

	/**
	 * Check if the data source is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Validate connection/credentials
	 */
	validateConnection?(): Promise<boolean>;

	/**
	 * Get supported query filters
	 */
	getSupportedFilters?(): readonly string[];
}

/**
 * Type guard for data source plugins
 */
export function isDataSourcePlugin(plugin: IPlugin): plugin is IDataSourcePlugin {
	return plugin.capabilities.includes('data-source');
}

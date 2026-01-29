/**
 * Extracted content from a data source
 */
export interface DataSourceContent {
	/** Extracted raw text/markdown content */
	readonly rawContent: string;
	/** Optional metadata about the content */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Content Extractor Facade interface for pipeline steps.
 *
 * Provides specialized content extraction from various data sources.
 * Data source plugins (Notion, Google Docs, etc.) are resolved through
 * the plugin system.
 */
export interface IContentExtractorFacade {
	/**
	 * Extract content from a URL using the appropriate data source plugin.
	 *
	 * The facade will determine which data source plugin handles the URL
	 * based on the URL pattern (e.g., notion.so → Notion plugin).
	 *
	 * @param url - URL to extract content from
	 * @returns Extracted content or null if no plugin can handle the URL
	 *
	 * @example
	 * ```typescript
	 * // Notion URL → handled by Notion data source plugin
	 * const content = await extractor.extractContent('https://notion.so/page-id');
	 *
	 * // Google Docs URL → handled by Google Docs data source plugin
	 * const content = await extractor.extractContent('https://docs.google.com/...');
	 * ```
	 */
	extractContent(url: string): Promise<DataSourceContent | null>;

	/**
	 * Check if any data source plugin can handle the given URL.
	 *
	 * @param url - URL to check
	 * @returns true if a data source plugin is available for this URL
	 */
	canHandle(url: string): boolean;

	/**
	 * Check if content extraction is configured for the given URL type.
	 *
	 * @param url - URL to check
	 * @returns true if the data source plugin is properly configured
	 */
	isConfigured(url: string): boolean;
}

/**
 * Search result from web search (facade-specific)
 */
export interface SearchFacadeResult {
	/** Result title */
	readonly title: string;
	/** Result URL */
	readonly url: string;
	/** Relevance score */
	readonly score: number;
	/** Published date if available */
	readonly publishedDate?: string;
}

/**
 * Search options for web search (facade-specific)
 */
export interface SearchFacadeOptions {
	/** Maximum number of results to return */
	readonly maxResults?: number;
	/** Domains to include */
	readonly includeDomains?: readonly string[];
	/** Domains to exclude */
	readonly excludeDomains?: readonly string[];
}

/**
 * Search Facade interface for pipeline steps.
 *
 * Provides web search capabilities ONLY.
 * Content extraction is handled by ContentExtractorFacade.
 *
 * The actual implementation handles provider resolution and settings.
 */
export interface ISearchFacade {
	/**
	 * Perform a web search.
	 *
	 * @param query - Search query string
	 * @param options - Optional search configuration
	 * @returns Array of search results sorted by relevance
	 *
	 * @example
	 * ```typescript
	 * const results = await searchFacade.search('best react frameworks', {
	 *     maxResults: 20
	 * });
	 * ```
	 */
	search(query: string, options?: SearchFacadeOptions): Promise<SearchFacadeResult[]>;

	/**
	 * Check if search service is configured and available.
	 */
	isConfigured(): boolean;
}

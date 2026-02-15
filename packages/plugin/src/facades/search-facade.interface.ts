import type { IBaseFacade } from './base-facade.interface.js';
import type { FacadeOptions } from './facade-options.interface.js';

export interface SearchFacadeResult {
	readonly title: string;
	readonly url: string;
	readonly score: number;
	readonly publishedDate?: string;
}

export interface SearchFacadeOptions {
	readonly maxResults?: number;
	readonly includeDomains?: readonly string[];
	readonly excludeDomains?: readonly string[];
}

/**
 * Search Facade interface for pipeline steps.
 *
 * Provides web search capabilities ONLY.
 * Content extraction is handled by ContentExtractorFacade.
 */
export interface ISearchFacade extends IBaseFacade {
	/**
	 * @example
	 * ```typescript
	 * const results = await searchFacade.search('best react frameworks', {
	 *     maxResults: 20
	 * });
	 * ```
	 */
	search(
		query: string,
		options: SearchFacadeOptions | undefined,
		facadeOptions: FacadeOptions
	): Promise<SearchFacadeResult[]>;
}

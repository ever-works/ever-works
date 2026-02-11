import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Search query options
 */
export interface SearchOptions {
	/** Search query string */
	readonly query: string;
	/** Number of results to return */
	readonly limit?: number;
	/** Page number for pagination */
	readonly page?: number;
	/** Language/locale */
	readonly language?: string;
	/** Country/region for results */
	readonly region?: string;
	/** Safe search level */
	readonly safeSearch?: 'off' | 'moderate' | 'strict';
	/** Time range filter */
	readonly timeRange?: 'day' | 'week' | 'month' | 'year' | 'all';
	/** Site to search within */
	readonly site?: string;
	/** File type filter */
	readonly fileType?: string;
	/** Exclude domains */
	readonly excludeDomains?: readonly string[];
	/** Include only these domains */
	readonly includeDomains?: readonly string[];
	/**
	 * Resolved settings for this operation.
	 * Passed by the facade with user/directory-scoped settings.
	 * Plugins should use these settings instead of their stored defaults.
	 */
	readonly settings?: PluginSettings;
}

/**
 * Individual search result
 */
export interface SearchResult {
	/** Result title */
	readonly title: string;
	/** Result URL */
	readonly url: string;
	/** Result snippet/description */
	readonly snippet?: string;
	/** Display URL */
	readonly displayUrl?: string;
	/** Favicon URL */
	readonly faviconUrl?: string;
	/** Published date */
	readonly publishedDate?: string;
	/** Result position */
	readonly position: number;
	/** Source/domain */
	readonly source?: string;
	/** Additional metadata */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Search response
 */
export interface SearchResponse {
	/** Search results */
	readonly results: readonly SearchResult[];
	/** Total number of results (estimate) */
	readonly totalResults?: number;
	/** Search query used */
	readonly query: string;
	/** Search duration in ms */
	readonly duration?: number;
	/** Next page token/number */
	readonly nextPage?: number | string;
	/** Whether there are more results */
	readonly hasMore: boolean;
	/** Related searches */
	readonly relatedSearches?: readonly string[];
}

/**
 * Search plugin interface
 * Capability: 'search'
 */
export interface ISearchPlugin extends IPlugin {
	/** Provider name (e.g., 'google', 'bing', 'serper', 'tavily') */
	readonly providerName: string;

	/**
	 * Perform a web search
	 */
	search(options: SearchOptions): Promise<SearchResponse>;

	/**
	 * Check if the service is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Get rate limit information
	 */
	getRateLimitInfo?(): Promise<RateLimitInfo>;

	/**
	 * Get supported regions/languages
	 */
	getSupportedRegions?(): readonly string[];
	getSupportedLanguages?(): readonly string[];
}

/**
 * Rate limit information
 */
export interface RateLimitInfo {
	/** Requests remaining */
	readonly remaining: number;
	/** Total limit */
	readonly limit: number;
	/** When limit resets (Unix timestamp) */
	readonly resetsAt?: number;
	/** Limit period (e.g., 'day', 'month') */
	readonly period?: string;
}

/**
 * Type guard for search plugins
 */
export function isSearchPlugin(plugin: IPlugin): plugin is ISearchPlugin {
	return plugin.capabilities.includes('search');
}

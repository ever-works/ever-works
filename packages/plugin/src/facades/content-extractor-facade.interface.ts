import type { FacadeOptions } from './facade-options.interface.js';

export interface FacadeExtractedContent {
	readonly url: string;
	readonly rawContent: string;
	readonly images?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

export interface FacadeExtractionOptions {
	readonly providerOverride?: string;
	readonly includeImages?: boolean;
	readonly includeLinks?: boolean;
}

/**
 * Content Extractor Facade interface for pipeline steps.
 *
 * Resolution order:
 * 1. Explicit provider override
 * 2. Non-system extractors (Tavily Extract, Firecrawl)
 * 3. System/default extractor (local-content-extractor)
 */
export interface IContentExtractorFacade {
	/**
	 * @example
	 * ```typescript
	 * // Uses default resolution (prefers non-system extractors)
	 * const content = await extractor.extractContent('https://example.com');
	 *
	 * // Force specific extractor
	 * const content = await extractor.extractContent('https://example.com', {
	 *     providerOverride: 'local-content-extractor'
	 * });
	 * ```
	 */
	extractContent(
		url: string,
		options?: FacadeExtractionOptions,
		facadeOptions?: FacadeOptions
	): Promise<FacadeExtractedContent | null>;

	isConfigured(): boolean;
}

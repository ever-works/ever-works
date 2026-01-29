/**
 * Extracted content from any URL (facade result type)
 */
export interface FacadeExtractedContent {
	/** Source URL */
	readonly url: string;
	/** Extracted raw text/markdown content */
	readonly rawContent: string;
	/** Extracted images */
	readonly images?: readonly string[];
	/** Optional metadata about the content */
	readonly metadata?: Record<string, unknown>;
}

/**
 * Content extraction options for the facade.
 *
 * Note: This is separate from ContentExtractionOptions in the plugin interface,
 * which is used when calling plugin.extract() directly.
 */
export interface FacadeExtractionOptions {
	/** Override the default content extractor plugin */
	readonly providerOverride?: string;
	/** Include images in extraction */
	readonly includeImages?: boolean;
	/** Include links in extraction */
	readonly includeLinks?: boolean;
}

/**
 * Content Extractor Facade interface for pipeline steps.
 *
 * Provides unified content extraction from any URL.
 * Routes to appropriate plugin based on URL pattern or user selection.
 *
 * Resolution order:
 * 1. Explicit provider override
 * 2. Non-system extractors (Tavily Extract, Firecrawl)
 * 3. System/default extractor (local-content-extractor)
 */
export interface IContentExtractorFacade {
	/**
	 * Extract content from a URL.
	 *
	 * Resolution order:
	 * 1. Explicit provider override (if specified in options)
	 * 2. Non-system extractors (Tavily, Firecrawl)
	 * 3. System/default extractor (local-content-extractor)
	 *
	 * @param url - URL to extract content from
	 * @param options - Optional extraction configuration
	 * @returns Extracted content or null if extraction fails
	 *
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
	extractContent(url: string, options?: FacadeExtractionOptions): Promise<FacadeExtractedContent | null>;

	/**
	 * Check if content extraction is configured and available.
	 *
	 * @returns true if any content extractor plugin is enabled
	 */
	isConfigured(): boolean;
}

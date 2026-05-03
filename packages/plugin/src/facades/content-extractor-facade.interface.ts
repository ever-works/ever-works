import type { IBaseFacade } from './base-facade.interface.js';
import type { FacadeOptions } from './facade-options.interface.js';

export interface FacadeExtractedContent {
	readonly url: string;
	readonly rawContent: string;
	readonly images?: readonly string[];
	readonly metadata?: Record<string, unknown>;
	readonly extraction?: FacadeExtractionDiagnostics;
}

export interface FacadeExtractionAttempt {
	readonly providerId: string;
	readonly providerName: string;
	readonly success: boolean;
	readonly error?: string;
	readonly contentLength?: number;
}

export interface FacadeExtractionDiagnostics {
	readonly providerId: string;
	readonly providerName: string;
	readonly attempts: readonly FacadeExtractionAttempt[];
}

export interface FacadeContentExtractionResult {
	readonly content: FacadeExtractedContent | null;
	readonly attempts: readonly FacadeExtractionAttempt[];
	readonly error?: string;
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
export interface IContentExtractorFacade extends IBaseFacade {
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
		options: FacadeExtractionOptions | undefined,
		facadeOptions: FacadeOptions
	): Promise<FacadeExtractedContent | null>;

	extractContentWithDiagnostics?(
		url: string,
		options: FacadeExtractionOptions | undefined,
		facadeOptions: FacadeOptions
	): Promise<FacadeContentExtractionResult>;
}

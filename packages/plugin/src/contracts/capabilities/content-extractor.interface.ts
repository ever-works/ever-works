import type { IPlugin } from '../plugin.interface.js';

/**
 * Content extraction options
 */
export interface ContentExtractionOptions {
	/** URL to extract content from */
	readonly url: string;
	/** Include images */
	readonly includeImages?: boolean;
	/** Include links */
	readonly includeLinks?: boolean;
	/** Include metadata */
	readonly includeMetadata?: boolean;
	/** Maximum content length */
	readonly maxLength?: number;
	/** Timeout in ms */
	readonly timeout?: number;
	/** Wait for JavaScript rendering */
	readonly waitForJs?: boolean;
	/** Wait for selector */
	readonly waitForSelector?: string;
	/** Custom headers */
	readonly headers?: Record<string, string>;
	/** Custom user agent */
	readonly userAgent?: string;
	/** Extract specific selectors */
	readonly selectors?: readonly string[];
	/** Remove selectors */
	readonly removeSelectors?: readonly string[];
}

/**
 * Extracted image information
 */
export interface ExtractedImage {
	readonly src: string;
	readonly alt?: string;
	readonly title?: string;
	readonly width?: number;
	readonly height?: number;
}

/**
 * Extracted link information
 */
export interface ExtractedLink {
	readonly href: string;
	readonly text?: string;
	readonly title?: string;
	readonly rel?: string;
	readonly isExternal: boolean;
}

/**
 * Page metadata
 */
export interface PageMetadata {
	readonly title?: string;
	readonly description?: string;
	readonly author?: string;
	readonly publishedDate?: string;
	readonly modifiedDate?: string;
	readonly language?: string;
	readonly keywords?: readonly string[];
	readonly ogTitle?: string;
	readonly ogDescription?: string;
	readonly ogImage?: string;
	readonly ogType?: string;
	readonly twitterCard?: string;
	readonly twitterTitle?: string;
	readonly twitterDescription?: string;
	readonly twitterImage?: string;
	readonly canonicalUrl?: string;
	readonly favicon?: string;
}

/**
 * Content extraction result
 */
export interface ContentExtractionResult {
	/** Whether extraction was successful */
	readonly success: boolean;
	/** Source URL */
	readonly url: string;
	/** Final URL (after redirects) */
	readonly finalUrl?: string;
	/** Extracted title */
	readonly title?: string;
	/** Extracted text content */
	readonly content?: string;
	/** Extracted HTML content */
	readonly html?: string;
	/** Extracted markdown content */
	readonly markdown?: string;
	/** Extracted images */
	readonly images?: readonly ExtractedImage[];
	/** Extracted links */
	readonly links?: readonly ExtractedLink[];
	/** Page metadata */
	readonly metadata?: PageMetadata;
	/** Error message if failed */
	readonly error?: string;
	/** Extraction duration in ms */
	readonly duration?: number;
	/** Content word count */
	readonly wordCount?: number;
	/** Content reading time estimate (minutes) */
	readonly readingTime?: number;
}

/**
 * Content extractor plugin interface
 * Capability: 'content-extractor'
 */
export interface IContentExtractorPlugin extends IPlugin {
	/** Provider name (e.g., 'firecrawl', 'jina', 'readability') */
	readonly providerName: string;

	/**
	 * Extract content from a URL
	 */
	extract(options: ContentExtractionOptions): Promise<ContentExtractionResult>;

	/**
	 * Extract content from multiple URLs
	 */
	extractBatch?(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]>;

	/**
	 * Check if the service is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Check if a URL can be extracted
	 */
	canExtract?(url: string): Promise<boolean>;

	/**
	 * Get supported output formats
	 */
	getSupportedFormats?(): readonly ('text' | 'html' | 'markdown')[];
}

/**
 * Type guard for content extractor plugins
 */
export function isContentExtractorPlugin(plugin: IPlugin): plugin is IContentExtractorPlugin {
	return plugin.capabilities.includes('content-extractor');
}

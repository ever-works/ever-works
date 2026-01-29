/**
 * Domain type classification for directory content
 */
export enum DomainType {
	SOFTWARE = 'software',
	ECOMMERCE = 'ecommerce',
	SERVICES = 'services',
	GENERAL = 'general'
}

/**
 * Result of domain analysis for a directory
 */
export interface DomainAnalysis {
	/** The detected domain type */
	readonly domain_type: DomainType;
	/** Confidence score from 0.0 to 1.0 */
	readonly confidence: number;
	/** The noun used to describe items in this domain (e.g., "tool", "product") */
	readonly item_noun?: string;
	/** Expected attributes for items in this domain */
	readonly expected_attributes?: readonly string[];
	/** URL patterns that indicate official sources */
	readonly official_source_patterns?: readonly string[];
	/** Domains known to be aggregators rather than official sources */
	readonly aggregator_domains?: readonly string[];
}

/**
 * Web page data retrieved during content extraction
 */
export interface WebPageData {
	/** The source URL of the page */
	readonly source_url: string;
	/** ISO date string when the content was retrieved */
	readonly retrieved_at: string;
	/** Raw content extracted from the page */
	readonly raw_content: string;
}

/**
 * Relevance assessment for a piece of content
 */
export interface RelevanceAssessment {
	/** Whether the content is relevant */
	readonly relevant: boolean;
	/** Relevance score from 0.0 to 1.0 */
	readonly relevance_score: number;
	/** Human-readable reason for the assessment */
	readonly reason: string;
}

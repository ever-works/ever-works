/**
 * DTO for extracting item details from a URL
 */
export interface ExtractItemDetailsDto {
	/** Source URL to extract details from */
	source_url: string;
	/** Optional work context for provider resolution and usage attribution */
	workId?: string;
	/** Existing categories in the work for matching */
	existing_categories?: string[];
}

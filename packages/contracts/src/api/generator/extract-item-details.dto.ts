/**
 * DTO for extracting item details from a URL
 */
export interface ExtractItemDetailsDto {
	/** Source URL to extract details from */
	source_url: string;
	/** Existing categories in the work for matching */
	existing_categories?: string[];
}

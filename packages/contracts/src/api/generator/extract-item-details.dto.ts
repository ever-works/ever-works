/**
 * DTO for extracting item details from a URL
 */
export interface ExtractItemDetailsDto {
	/** Source URL to extract details from */
	source_url: string;
	/** Existing categories in the directory for matching */
	existing_categories?: string[];
}

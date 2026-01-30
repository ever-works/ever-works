/**
 * DTO for submitting a new item to a directory
 *
 * Note: Either `category` (single) or `categories` (array) must be provided.
 * The backend validates this with conditional validation.
 */
export interface SubmitItemDto {
	/** Item name */
	name: string;
	/** Item description */
	description: string;
	/** Source URL for the item */
	source_url: string;
	/** Primary category (required if categories is not provided) */
	category?: string;
	/** Additional categories (required if category is not provided) */
	categories?: string[];
	/** Tags for the item */
	tags?: string[];
	/** Whether item is featured */
	featured?: boolean;
	/** Display order */
	order?: number;
	/** Whether to pay and publish immediately */
	pay_and_publish_now?: boolean;
	/** URL-friendly slug */
	slug?: string;
	/** Brand name */
	brand?: string;
	/** Brand logo URL */
	brand_logo_url?: string;
	/** Item images */
	images?: string[];
	/** Whether to create a pull request */
	create_pull_request?: boolean;
}

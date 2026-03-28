/**
 * DTO for updating item metadata in a directory
 */
export interface UpdateItemDto {
	/** Slug of the item to update */
	item_slug: string;
	/** Source URL */
	source_url?: string;
	/** Whether item is featured */
	featured?: boolean;
	/** Display order */
	order?: number;
	/** Whether to create a pull request */
	create_pull_request?: boolean;
}

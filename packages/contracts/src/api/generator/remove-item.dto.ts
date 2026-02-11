/**
 * DTO for removing an item from a directory
 */
export interface RemoveItemDto {
	/** Slug of the item to remove */
	item_slug: string;
	/** Reason for removal */
	reason?: string;
	/** Whether to create a pull request */
	create_pull_request?: boolean;
}

/**
 * DTO for updating item metadata in a work
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
	/** Long-form markdown body. When provided, replaces the existing
	 *  `data/<slug>/<slug>.md` file and mirrors onto the YAML `markdown` field. */
	markdown?: string;
}

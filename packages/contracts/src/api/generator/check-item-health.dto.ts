import type { ItemData, ItemHealth } from '../../item/item.types.js';

/**
 * DTO for manually checking a single item's source URL health.
 */
export interface CheckItemHealthDto {
	/** Slug of the item to check */
	item_slug: string;
}

/**
 * Response returned after checking a single item's source URL health.
 */
export interface CheckItemHealthResponseDto {
	status: 'success' | 'error';
	item_slug: string;
	item_name: string;
	message: string;
	item?: ItemData;
	health?: ItemHealth;
}

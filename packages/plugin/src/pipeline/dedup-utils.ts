import type { MutableItemData } from '../common/index.js';

/**
 * Pure deduplication utility functions.
 *
 * These are standalone helpers with zero side-effects, designed to be shared
 * across pipeline implementations (standard-pipeline, agent-pipeline, etc.).
 */

/**
 * Deduplicates items by a specific field.
 * Last-write-wins: if two items share the same field value the later one is kept.
 */
export function deduplicateByField<T extends { [K in F]?: string | null | undefined } & object, F extends string>(
	items: T[],
	field: F
): T[] {
	if (!items || items.length === 0) return [];

	// Skip deduplication if the field doesn't exist in the items
	if (!items.some((item) => item[field] !== undefined && item[field] !== null)) {
		return items;
	}

	const map = new Map<string, T>();
	for (const item of items) {
		const value = item[field];
		if (value !== undefined && value !== null && typeof value === 'string') {
			map.set(value, item);
		} else {
			// If the field is missing or not a string, use a unique identifier
			map.set(`__no_${String(field)}_${Math.random()}`, item);
		}
	}
	return Array.from(map.values());
}

/**
 * Normalizes a URL for deduplication comparison.
 * Strips protocol, www prefix, trailing slashes, and git tree/blob paths.
 */
export function normalizeUrl(url: string): string {
	if (!url) return '';

	return (
		url
			.toLowerCase()
			.trim()
			// Remove protocol
			.replace(/^https?:\/\//, '')
			// Remove www prefix
			.replace(/^www\./, '')
			// Remove trailing slashes
			.replace(/\/+$/, '')
			// Normalize git tree/blob paths to base repo
			.replace(/\/(tree|blob)\/[^/]+.*$/, '')
			// Remove hash fragments
			.replace(/#.*$/, '')
			// Remove common trailing index files
			.replace(/\/index\.(html?|php|aspx?)$/, '')
	);
}

/**
 * Normalizes item name for comparison.
 * Removes version numbers, special characters, and common tech suffixes.
 */
export function normalizeItemName(name: string): string {
	if (!name) return '';

	return name
		.toLowerCase()
		.replace(/\s+v?(\d+\.)*\d+(\s+|$)/g, ' ')
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/\b(js|javascript|library|framework|tool|app|application)\b/g, '')
		.trim();
}

/**
 * Creates a fast lookup index for existing items using multiple keys
 * (slug, source URL, normalized name, normalized URL).
 */
export function createItemLookupIndex(items: MutableItemData[]): Map<string, MutableItemData> {
	const index = new Map<string, MutableItemData>();

	for (const item of items) {
		// Index by slug
		if (item.slug) {
			index.set(`slug:${item.slug.toLowerCase()}`, item);
		}

		// Index by source URL
		if (item.source_url) {
			index.set(`url:${item.source_url.toLowerCase()}`, item);
		}

		// Index by normalized name
		const normalizedName = normalizeItemName(item.name);
		if (normalizedName) {
			index.set(`name:${normalizedName}`, item);
		}

		// Index by normalized URL (catches www vs non-www, trailing slashes, git paths)
		if (item.source_url) {
			const normalizedUrlValue = normalizeUrl(item.source_url);
			if (normalizedUrlValue) {
				index.set(`nurl:${normalizedUrlValue}`, item);
			}
		}
	}

	return index;
}

/**
 * Checks if a new item already exists in the lookup index using multiple strategies.
 */
export function isItemDuplicate(newItem: MutableItemData, lookupIndex: Map<string, MutableItemData>): boolean {
	// Check by slug
	if (newItem.slug && lookupIndex.has(`slug:${newItem.slug.toLowerCase()}`)) {
		return true;
	}

	// Check by exact source URL
	if (newItem.source_url && lookupIndex.has(`url:${newItem.source_url.toLowerCase()}`)) {
		return true;
	}

	// Check by normalized name
	const normalizedName = normalizeItemName(newItem.name);
	if (normalizedName && lookupIndex.has(`name:${normalizedName}`)) {
		return true;
	}

	// Check by normalized URL (catches www vs non-www, trailing slashes, git paths)
	if (newItem.source_url) {
		const normalizedUrlValue = normalizeUrl(newItem.source_url);
		if (normalizedUrlValue && lookupIndex.has(`nurl:${normalizedUrlValue}`)) {
			return true;
		}
	}

	return false;
}

/**
 * Filters new items using manual (field-based) deduplication strategies.
 * Returns only items from `newItems` that don't exist in `existingItems`.
 */
export function filterNewItemsManually(
	existingItems: MutableItemData[],
	newItems: MutableItemData[]
): MutableItemData[] {
	if (!newItems || newItems.length === 0) return [];
	if (!existingItems || existingItems.length === 0) return newItems;

	// Create lookup index for fast comparison
	const lookupIndex = createItemLookupIndex(existingItems);

	// Filter out duplicates
	return newItems.filter((newItem) => !isItemDuplicate(newItem, lookupIndex));
}

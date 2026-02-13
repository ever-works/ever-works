import type { MutableItemData } from '../common/index.js';

export function deduplicateByField<T extends { [K in F]?: string | null | undefined } & object, F extends string>(
	items: T[],
	field: F
): T[] {
	if (!items || items.length === 0) return [];

	if (!items.some((item) => item[field] !== undefined && item[field] !== null)) {
		return items;
	}

	const map = new Map<string, T>();
	for (const item of items) {
		const value = item[field];
		if (value !== undefined && value !== null && typeof value === 'string') {
			map.set(value, item);
		} else {
			map.set(`__no_${String(field)}_${Math.random()}`, item);
		}
	}
	return Array.from(map.values());
}

export function normalizeUrl(url: string): string {
	if (!url) return '';

	return url
		.toLowerCase()
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/^www\./, '')
		.replace(/\/+$/, '')
		.replace(/\/(tree|blob)\/[^/]+.*$/, '')
		.replace(/#.*$/, '')
		.replace(/\/index\.(html?|php|aspx?)$/, '');
}

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

export function createItemLookupIndex(items: MutableItemData[]): Map<string, MutableItemData> {
	const index = new Map<string, MutableItemData>();

	for (const item of items) {
		if (item.slug) {
			index.set(`slug:${item.slug.toLowerCase()}`, item);
		}
		if (item.source_url) {
			index.set(`url:${item.source_url.toLowerCase()}`, item);
			const normalized = normalizeUrl(item.source_url);
			if (normalized) {
				index.set(`nurl:${normalized}`, item);
			}
		}
		const normalizedName = normalizeItemName(item.name);
		if (normalizedName) {
			index.set(`name:${normalizedName}`, item);
		}
	}

	return index;
}

export function isItemDuplicate(newItem: MutableItemData, lookupIndex: Map<string, MutableItemData>): boolean {
	if (newItem.slug && lookupIndex.has(`slug:${newItem.slug.toLowerCase()}`)) {
		return true;
	}
	if (newItem.source_url && lookupIndex.has(`url:${newItem.source_url.toLowerCase()}`)) {
		return true;
	}
	const normalizedName = normalizeItemName(newItem.name);
	if (normalizedName && lookupIndex.has(`name:${normalizedName}`)) {
		return true;
	}
	if (newItem.source_url) {
		const normalized = normalizeUrl(newItem.source_url);
		if (normalized && lookupIndex.has(`nurl:${normalized}`)) {
			return true;
		}
	}
	return false;
}

export function filterNewItemsManually(
	existingItems: MutableItemData[],
	newItems: MutableItemData[]
): MutableItemData[] {
	if (!newItems || newItems.length === 0) return [];
	if (!existingItems || existingItems.length === 0) return newItems;

	const lookupIndex = createItemLookupIndex(existingItems);
	return newItems.filter((newItem) => !isItemDuplicate(newItem, lookupIndex));
}

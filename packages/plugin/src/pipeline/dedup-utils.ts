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

/**
 * Reduce a URL to a canonical form for duplicate detection (NOT for
 * navigation — the output drops scheme and `www.` so it isn't a real URL).
 *
 * Transformations, in order:
 * 1. lowercase + trim
 * 2. strip `http://` / `https://`
 * 3. strip leading `www.`
 * 4. strip trailing slash(es)
 * 5. **strip GitHub branch paths** — `/tree/<branch>/...` and
 *    `/blob/<branch>/...` are removed so `github.com/foo/bar`,
 *    `github.com/foo/bar/tree/main`, and
 *    `github.com/foo/bar/blob/main/README.md` all collapse to the
 *    same canonical `github.com/foo/bar`. This is intentional —
 *    consumers should treat any deep link into a repo as a duplicate
 *    of the repo itself when ingesting items.
 * 6. strip fragments (`#...`)
 * 7. strip `/index.html|htm|php|asp|aspx` filenames
 *
 * Returns `''` for empty / falsy input.
 */
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

/**
 * Reduce an item name to a canonical form for duplicate detection.
 *
 * **Aggressive** — designed to catch near-duplicates with cosmetic
 * differences ("React.js v18.2", "React Framework", "react"), not to
 * produce a human-readable label. Transformations, in order:
 * 1. lowercase
 * 2. **strip trailing version tags** — ` v1`, ` 1.0`, ` 2.0.3`, etc.
 *    are removed so the same item across releases collapses to one
 *    name.
 * 3. replace non-word non-space chars with space (drops punctuation)
 * 4. collapse runs of whitespace
 * 5. **strip noise-token suffixes** — the words `js`, `javascript`,
 *    `library`, `framework`, `tool`, `app`, `application` are
 *    removed wherever they appear. So "React.js Framework" and
 *    "React" collapse to "react". DO NOT add the project's own
 *    item-type vocabulary to this list without checking — it'd
 *    erase legitimately distinct items.
 * 6. trim
 *
 * Returns `''` for empty / falsy input. The output is never shown
 * to users — it lives only as a Map key in
 * {@link createItemLookupIndex} / {@link isItemDuplicate}.
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

import type { ItemData, Category, Tag, Brand } from '@ever-works/plugin';
import type { MakeWorkflowOutput, MakeOutputItem } from '../types.js';

export interface ParsedResults {
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	brands: Brand[];
}

/**
 * Parses and validates the output from a Make.com scenario/webhook execution.
 * Transforms Make.com output items into Ever Works ItemData format.
 */
export function parseMakeOutput(raw: unknown): ParsedResults {
	if (!raw || (typeof raw !== 'object' && typeof raw !== 'string')) {
		throw new Error('Make.com scenario returned empty or non-object output');
	}

	const output = normalizeOutput(raw);

	const items = parseItems(output.items ?? []);

	if (items.length === 0) {
		throw new Error(
			'Make.com scenario returned a valid response but with no usable items. ' +
				'Ensure the final module emits a JSON object with an { items: [...] } array. ' +
				'Check the scenario execution logs in the Make.com dashboard.'
		);
	}

	const categories = parseCategories(output.categories, items);
	const tags = parseTags(output.tags, items);
	const brands = parseBrands(output.brands, items);

	return { items, categories, tags, brands };
}

/**
 * Normalizes the raw Make.com output into the expected shape.
 * Make scenarios can wrap the actual payload in various response shapes,
 * so we try to unwrap common nested fields before giving up.
 */
function normalizeOutput(raw: unknown): MakeWorkflowOutput {
	if (typeof raw === 'string') {
		const parsed = tryParse(raw);
		if (parsed !== null && typeof parsed === 'object') {
			return normalizeOutput(parsed);
		}
		const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
		throw new Error(
			'Make.com scenario returned a string that is not valid JSON. ' +
				'Ensure the final module returns a JSON object with { items: [...] }. ' +
				`Received: ${preview}`
		);
	}

	if (Array.isArray(raw)) {
		return { items: raw as MakeOutputItem[] };
	}

	const obj = raw as Record<string, unknown>;

	if ('items' in obj) {
		const items: MakeOutputItem[] = Array.isArray(obj.items) ? obj.items : [];
		return {
			items,
			categories: obj.categories as MakeWorkflowOutput['categories'],
			tags: obj.tags as MakeWorkflowOutput['tags'],
			brands: obj.brands as MakeWorkflowOutput['brands']
		};
	}

	for (const key of ['output', 'result', 'data', 'response', 'body', 'payload']) {
		if (obj[key] != null && obj[key] !== '') {
			return normalizeOutput(obj[key]);
		}
	}

	if (typeof obj.message === 'string') {
		const parsed = tryParse(obj.message);
		if (parsed !== null && typeof parsed === 'object') {
			return normalizeOutput(parsed);
		}
	}

	throw new Error(
		'Make.com scenario output does not contain an "items" array. ' +
			'Expected format: { items: [...] } or a direct array of items. ' +
			`Received keys: ${Object.keys(obj).join(', ')}`
	);
}

function tryParse(str: string): unknown {
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}

function parseItems(rawItems: MakeOutputItem[]): ItemData[] {
	const items: ItemData[] = [];

	for (const raw of rawItems) {
		if (!raw || typeof raw !== 'object') continue;
		if (!raw.name || typeof raw.name !== 'string') continue;

		const item: ItemData = {
			name: raw.name.trim(),
			description: typeof raw.description === 'string' ? raw.description.trim() : '',
			source_url:
				typeof raw.url === 'string' ? raw.url : typeof raw.source_url === 'string' ? raw.source_url : '',
			markdown: typeof raw.content === 'string' ? raw.content : undefined,
			category: typeof raw.category === 'string' ? raw.category.trim() : '',
			tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
			brand: typeof raw.brand === 'string' ? raw.brand.trim() : undefined,
			images: Array.isArray(raw.images) ? raw.images.filter((i): i is string => typeof i === 'string') : undefined
		};

		items.push(item);
	}

	return items;
}

function parseCategories(rawCategories: MakeWorkflowOutput['categories'], items: ItemData[]): Category[] {
	const categoryNames = new Set<string>();

	if (Array.isArray(rawCategories)) {
		for (const cat of rawCategories) {
			if (cat && typeof cat.name === 'string' && cat.name.trim()) {
				categoryNames.add(cat.name.trim());
			}
		}
	}

	for (const item of items) {
		if (typeof item.category === 'string' && item.category) {
			categoryNames.add(item.category);
		} else if (Array.isArray(item.category)) {
			for (const c of item.category) {
				if (typeof c === 'string' && c.trim()) categoryNames.add(c.trim());
			}
		}
	}

	return Array.from(categoryNames).map((name) => {
		const explicit = rawCategories?.find((c) => c.name === name);
		return {
			id: name.toLowerCase().replace(/\s+/g, '-'),
			name,
			description: explicit?.description
		};
	});
}

function parseTags(rawTags: MakeWorkflowOutput['tags'], items: ItemData[]): Tag[] {
	const tagNames = new Set<string>();

	if (Array.isArray(rawTags)) {
		for (const tag of rawTags) {
			if (tag && typeof tag.name === 'string' && tag.name.trim()) {
				tagNames.add(tag.name.trim());
			}
		}
	}

	for (const item of items) {
		if (Array.isArray(item.tags)) {
			for (const t of item.tags) {
				if (typeof t === 'string') tagNames.add(t);
			}
		}
	}

	return Array.from(tagNames).map((name) => ({
		id: name.toLowerCase().replace(/\s+/g, '-'),
		name
	}));
}

function parseBrands(rawBrands: MakeWorkflowOutput['brands'], items: ItemData[]): Brand[] {
	const brandNames = new Set<string>();

	if (Array.isArray(rawBrands)) {
		for (const brand of rawBrands) {
			if (brand && typeof brand.name === 'string' && brand.name.trim()) {
				brandNames.add(brand.name.trim());
			}
		}
	}

	for (const item of items) {
		if (item.brand) {
			if (typeof item.brand === 'string') {
				brandNames.add(item.brand);
			} else if (typeof item.brand === 'object' && item.brand.name) {
				brandNames.add(item.brand.name);
			}
		}
	}

	return Array.from(brandNames).map((name) => {
		const explicit = rawBrands?.find((b) => b.name === name);
		return {
			id: name.toLowerCase().replace(/\s+/g, '-'),
			name,
			website: explicit?.url
		};
	});
}

/**
 * Deduplicates new items against existing items by name (case-insensitive).
 */
export function deduplicateItems(newItems: ItemData[], existingItemNames: string[]): ItemData[] {
	const existingSet = new Set(existingItemNames.map((n) => n.toLowerCase().trim()));
	return newItems.filter((item) => !existingSet.has(item.name.toLowerCase().trim()));
}

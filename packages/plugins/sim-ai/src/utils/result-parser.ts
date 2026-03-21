import type { ItemData, Category, Tag, Brand } from '@ever-works/plugin';
import type { SimWorkflowOutput, SimOutputItem } from '../types.js';

export interface ParsedResults {
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	brands: Brand[];
}

/**
 * Parses and validates the output from a SIM workflow execution.
 * Transforms SIM output items into Ever Works ItemData format.
 */
export function parseSimOutput(raw: unknown): ParsedResults {
	if (!raw || typeof raw !== 'object') {
		throw new Error('SIM workflow returned empty or non-object output');
	}

	const output = normalizeOutput(raw);

	const items = parseItems(output.items ?? []);

	if (items.length === 0) {
		throw new Error(
			'SIM workflow returned a valid response but with no usable items. ' +
				'The Agent may not be generating content correctly. ' +
				'Check the Agent block output in the SIM dashboard logs.'
		);
	}

	const categories = parseCategories(output.categories, items);
	const tags = parseTags(output.tags, items);
	const brands = parseBrands(output.brands, items);

	return { items, categories, tags, brands };
}

/**
 * Normalizes the raw SIM output into the expected shape.
 * SIM workflows can return results in many formats depending on the
 * block configuration (Agent -> Response, direct output, etc.).
 */
function normalizeOutput(raw: unknown): SimWorkflowOutput {
	if (typeof raw === 'string') {
		const parsed = tryParse(raw);
		if (parsed !== null && typeof parsed === 'object') {
			return normalizeOutput(parsed);
		}
		const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
		throw new Error(
			'SIM workflow returned a string that is not valid JSON. ' +
				'Ensure the Agent block returns a JSON object with { items: [...] }. ' +
				`Received: ${preview}`
		);
	}

	if (Array.isArray(raw)) {
		return { items: raw as SimOutputItem[] };
	}

	const obj = raw as Record<string, unknown>;

	if ('items' in obj) {
		const items = Array.isArray(obj.items) ? obj.items : [];
		return { ...obj, items } as unknown as SimWorkflowOutput;
	}

	// Unwrap common nested fields from SIM response shapes
	for (const key of ['output', 'result', 'content', 'data', 'response', 'ResponseDataMode', 'ResponseStructure']) {
		if (obj[key] != null) {
			return normalizeOutput(obj[key]);
		}
	}

	// Try parsing string values that might contain JSON with an items array
	if (typeof obj.message === 'string') {
		const parsed = tryParse(obj.message);
		if (parsed !== null && typeof parsed === 'object') {
			return normalizeOutput(parsed);
		}
	}

	throw new Error(
		'SIM workflow output does not contain an "items" array. ' +
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

function parseItems(rawItems: SimOutputItem[]): ItemData[] {
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

function parseCategories(rawCategories: SimWorkflowOutput['categories'], items: ItemData[]): Category[] {
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

function parseTags(rawTags: SimWorkflowOutput['tags'], items: ItemData[]): Tag[] {
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

function parseBrands(rawBrands: SimWorkflowOutput['brands'], items: ItemData[]): Brand[] {
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

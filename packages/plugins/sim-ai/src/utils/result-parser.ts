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

	const items = parseItems(output.items);
	const categories = parseCategories(output.categories, items);
	const tags = parseTags(output.tags, items);
	const brands = parseBrands(output.brands, items);

	return { items, categories, tags, brands };
}

/**
 * Normalizes the raw SIM output into the expected shape.
 * SIM workflows can return results in many formats depending on the
 * block configuration (Agent → Response, direct output, etc.).
 */
function normalizeOutput(raw: unknown): SimWorkflowOutput {
	// If raw is a string, it might be JSON (Agent blocks often return stringified JSON)
	if (typeof raw === 'string') {
		const parsed = tryParseJson(raw);
		if (parsed !== null) {
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

	// If output has an 'items' array, use it directly
	if (Array.isArray(obj.items)) {
		return obj as unknown as SimWorkflowOutput;
	}

	// If output has a nested 'output' field (from async execution)
	if (obj.output != null) {
		return normalizeOutput(obj.output);
	}

	// If output has a 'result' field (common in SIM response blocks)
	if (obj.result != null) {
		return normalizeOutput(obj.result);
	}

	// If output has a 'content' field (Agent block text output)
	if (obj.content != null) {
		return normalizeOutput(obj.content);
	}

	// If output has a 'data' field
	if (obj.data != null) {
		return normalizeOutput(obj.data);
	}

	// If output has a 'response' field
	if (obj.response != null) {
		return normalizeOutput(obj.response);
	}

	// If output has a 'message' field (sometimes the Agent response goes here)
	if (obj.message != null && typeof obj.message === 'string') {
		const parsed = tryParseJson(obj.message);
		if (parsed !== null) {
			return normalizeOutput(parsed);
		}
	}

	// SIM Response block fields: ResponseDataMode contains the Agent's text output
	if (obj.ResponseDataMode != null) {
		return normalizeOutput(obj.ResponseDataMode);
	}
	if (obj.ResponseStructure != null) {
		return normalizeOutput(obj.ResponseStructure);
	}

	// Last resort: scan all string values for embedded JSON with an "items" array
	for (const value of Object.values(obj)) {
		if (typeof value === 'string') {
			const parsed = tryParseJson(value);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const parsedObj = parsed as Record<string, unknown>;
				if (Array.isArray(parsedObj.items)) {
					return normalizeOutput(parsed);
				}
			}
		}
	}

	throw new Error(
		'SIM workflow output does not contain an "items" array. ' +
			'Expected format: { items: [...] } or a direct array of items. ' +
			`Received keys: ${Object.keys(obj).join(', ')}`
	);
}

/**
 * Attempts to parse a string as JSON. Returns null on failure.
 * Handles markdown-wrapped JSON (```json ... ```) from AI agents,
 * and also extracts JSON blocks embedded within surrounding text.
 */
function tryParseJson(str: string): unknown {
	let trimmed = str.trim();

	// Try direct parse first
	try {
		return JSON.parse(trimmed);
	} catch {
		// Continue to extraction strategies
	}

	// Extract JSON from markdown code fences (```json ... ``` or ``` ... ```)
	const codeFenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
	if (codeFenceMatch) {
		try {
			return JSON.parse(codeFenceMatch[1].trim());
		} catch {
			// Continue
		}
	}

	// Extract the first JSON object or array from the text
	const jsonStart = trimmed.search(/[\[{]/);
	if (jsonStart >= 0) {
		const candidate = trimmed.slice(jsonStart);
		// Find matching closing bracket by trying progressively shorter substrings
		const openChar = candidate[0];
		const closeChar = openChar === '{' ? '}' : ']';
		let lastClose = candidate.lastIndexOf(closeChar);
		while (lastClose >= 0) {
			try {
				return JSON.parse(candidate.slice(0, lastClose + 1));
			} catch {
				lastClose = candidate.lastIndexOf(closeChar, lastClose - 1);
			}
		}
	}

	return null;
}

function parseItems(rawItems: SimOutputItem[]): ItemData[] {
	const items: ItemData[] = [];

	for (const raw of rawItems) {
		if (!raw || typeof raw !== 'object') continue;
		if (!raw.name || typeof raw.name !== 'string') continue;

		const item: ItemData = {
			name: raw.name.trim(),
			description: typeof raw.description === 'string' ? raw.description.trim() : undefined,
			source_url:
				typeof raw.url === 'string' ? raw.url : typeof raw.source_url === 'string' ? raw.source_url : undefined,
			content: typeof raw.content === 'string' ? raw.content : undefined,
			category: typeof raw.category === 'string' ? raw.category.trim() : undefined,
			tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : undefined,
			brand: typeof raw.brand === 'string' ? raw.brand.trim() : undefined,
			images: Array.isArray(raw.images) ? raw.images.filter((i): i is string => typeof i === 'string') : undefined
		};

		items.push(item);
	}

	return items;
}

function parseCategories(rawCategories: SimWorkflowOutput['categories'], items: ItemData[]): Category[] {
	const categoryNames = new Set<string>();

	// From explicit categories in output
	if (Array.isArray(rawCategories)) {
		for (const cat of rawCategories) {
			if (cat && typeof cat.name === 'string' && cat.name.trim()) {
				categoryNames.add(cat.name.trim());
			}
		}
	}

	// From item category references
	for (const item of items) {
		if (item.category) {
			if (typeof item.category === 'string') {
				categoryNames.add(item.category);
			} else if (Array.isArray(item.category)) {
				for (const c of item.category) {
					if (typeof c === 'string' && c.trim()) categoryNames.add(c.trim());
				}
			}
		}
	}

	return Array.from(categoryNames).map((name) => {
		const explicit = rawCategories?.find((c) => c.name === name);
		return {
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
				tagNames.add(t);
			}
		}
	}

	return Array.from(tagNames).map((name) => ({ name }));
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
			name,
			url: explicit?.url
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

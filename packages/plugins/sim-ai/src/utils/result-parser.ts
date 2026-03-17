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

	// If output has an 'items' field, use it (handle null/empty as empty array)
	if ('items' in obj) {
		const items = Array.isArray(obj.items) ? obj.items : [];
		return { ...obj, items } as unknown as SimWorkflowOutput;
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
 * Handles markdown-wrapped JSON, embedded JSON blocks, and
 * common AI output errors (trailing commas, missing values, truncation).
 */
function tryParseJson(str: string): unknown {
	let trimmed = str.trim();

	// Try direct parse first
	const direct = tryParse(trimmed);
	if (direct !== null) return direct;

	// Try repairing common AI JSON errors
	const repaired = tryParse(repairJson(trimmed));
	if (repaired !== null) return repaired;

	// Extract JSON from markdown code fences (```json ... ``` or ``` ... ```)
	const codeFenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
	if (codeFenceMatch) {
		const fenceContent = codeFenceMatch[1].trim();
		const fenceParsed = tryParse(fenceContent) ?? tryParse(repairJson(fenceContent));
		if (fenceParsed !== null) return fenceParsed;
	}

	// Extract the first JSON object or array from the text
	const jsonStart = trimmed.search(/[\[{]/);
	if (jsonStart >= 0) {
		const candidate = trimmed.slice(jsonStart);
		const openChar = candidate[0];
		const closeChar = openChar === '{' ? '}' : ']';
		let lastClose = candidate.lastIndexOf(closeChar);
		while (lastClose >= 0) {
			const slice = candidate.slice(0, lastClose + 1);
			const parsed = tryParse(slice) ?? tryParse(repairJson(slice));
			if (parsed !== null) return parsed;
			lastClose = candidate.lastIndexOf(closeChar, lastClose - 1);
		}
	}

	return null;
}

/** Safe JSON.parse wrapper */
function tryParse(str: string): unknown {
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}

/**
 * Attempts to repair common JSON errors produced by AI models:
 * - Empty values: `"key": ,` or `"key": }` → `"key": null,` / `"key": null}`
 * - Trailing commas: `[1, 2, ]` → `[1, 2]`
 * - Truncated output: missing closing brackets
 * - Single quotes instead of double quotes
 */
function repairJson(str: string): string {
	let repaired = str;

	// Fix empty values: "key": , or "key": } or "key": ]
	repaired = repaired.replace(/:\s*,/g, ': null,');
	repaired = repaired.replace(/:\s*}/g, ': null}');
	repaired = repaired.replace(/:\s*]/g, ': null]');

	// Fix trailing commas before closing brackets
	repaired = repaired.replace(/,\s*}/g, '}');
	repaired = repaired.replace(/,\s*]/g, ']');

	// Fix truncated output: count unmatched brackets and close them
	let openBraces = 0;
	let openBrackets = 0;
	let inString = false;
	let escape = false;

	for (const ch of repaired) {
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === '\\' && inString) {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;

		if (ch === '{') openBraces++;
		else if (ch === '}') openBraces--;
		else if (ch === '[') openBrackets++;
		else if (ch === ']') openBrackets--;
	}

	// If we're in an unclosed string, close it
	if (inString) {
		repaired += '"';
	}

	// Remove any trailing comma before we close brackets
	repaired = repaired.replace(/,\s*$/, '');

	// Close any unclosed brackets/braces
	while (openBrackets > 0) {
		repaired += ']';
		openBrackets--;
	}
	while (openBraces > 0) {
		repaired += '}';
		openBraces--;
	}

	return repaired;
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

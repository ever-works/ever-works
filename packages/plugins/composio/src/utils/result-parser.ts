import type { ItemData, Category, Tag, Brand } from '@ever-works/plugin';
import type { ComposioToolOutput, ComposioOutputItem, ComposioResultShape, ComposioFieldMapping } from '../types.js';

export interface ParsedResults {
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	brands: Brand[];
}

/**
 * Parses the `data` returned by a Composio tool.
 *
 * Supports two shapes:
 *  - 'structured': the tool returns `{ items: [...], categories?, tags?, brands? }`
 *    (same contract as sim-ai / zapier — cleanest path for work generation)
 *  - 'native': the tool returns raw records produced by the underlying app,
 *    e.g. Gmail messages, Notion pages, GitHub issues. The caller provides
 *    a field mapping to project each record onto ItemData.
 */
export function parseComposioOutput(
	raw: unknown,
	shape: ComposioResultShape,
	mapping: ComposioFieldMapping
): ParsedResults {
	if (raw === null || raw === undefined) {
		throw new Error('Composio tool returned no data.');
	}

	if (shape === 'native') {
		const records = normalizeRecordList(raw);
		const items = records.map((record) => mapNativeRecord(record, mapping)).filter(isNonEmptyItem);

		if (items.length === 0) {
			throw new Error(
				'Composio tool returned records but none could be mapped to work items. ' +
					'Double-check the field mapping — at minimum the name field must point to a non-empty string.'
			);
		}

		const categories = parseCategories(undefined, items);
		const tags = parseTags(undefined, items);
		const brands = parseBrands(undefined, items);
		return { items, categories, tags, brands };
	}

	const output = normalizeStructured(raw);
	const items = parseItems(output.items ?? []);

	if (items.length === 0) {
		throw new Error(
			'Composio tool returned a structured response but with no usable items. ' +
				'Ensure the tool outputs `{ items: [...] }` with each item containing at least a `name`. ' +
				'If the tool returns native records instead, switch the result shape to "native" and set a field mapping.'
		);
	}

	const categories = parseCategories(output.categories, items);
	const tags = parseTags(output.tags, items);
	const brands = parseBrands(output.brands, items);
	return { items, categories, tags, brands };
}

/**
 * Normalizes a raw value into a ComposioToolOutput (the `{ items: [...] }` shape).
 */
function normalizeStructured(raw: unknown): ComposioToolOutput {
	if (typeof raw === 'string') {
		const parsed = tryParseJson(raw);
		if (parsed !== null && typeof parsed === 'object') {
			return normalizeStructured(parsed);
		}
		const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
		throw new Error(
			'Composio tool returned a string that is not valid JSON. ' +
				'Ensure the tool returns a JSON object with { items: [...] }. ' +
				`Received: ${preview}`
		);
	}

	if (Array.isArray(raw)) {
		if (raw.length === 1 && raw[0] && typeof raw[0] === 'object') {
			const single = raw[0] as Record<string, unknown>;
			for (const key of ['items', 'output', 'result', 'content', 'data', 'response', 'body', 'payload']) {
				if (single[key] != null && single[key] !== '') {
					return normalizeStructured(single);
				}
			}
		}
		return { items: raw as ComposioOutputItem[] };
	}

	if (!raw || typeof raw !== 'object') {
		throw new Error(`Composio tool returned an unexpected type: ${typeof raw}`);
	}

	const obj = raw as Record<string, unknown>;

	if ('items' in obj) {
		const items: ComposioOutputItem[] = Array.isArray(obj.items) ? (obj.items as ComposioOutputItem[]) : [];
		return {
			items,
			categories: obj.categories as ComposioToolOutput['categories'],
			tags: obj.tags as ComposioToolOutput['tags'],
			brands: obj.brands as ComposioToolOutput['brands']
		};
	}

	for (const key of ['output', 'result', 'content', 'data', 'response', 'body', 'payload']) {
		if (obj[key] != null && obj[key] !== '') {
			return normalizeStructured(obj[key]);
		}
	}

	if (typeof obj.message === 'string') {
		const parsed = tryParseJson(obj.message);
		if (parsed !== null && typeof parsed === 'object') {
			return normalizeStructured(parsed);
		}
	}

	throw new Error(
		'Composio tool output does not contain an "items" array. ' +
			'Expected `{ items: [...] }` or a direct array. ' +
			`Received keys: ${Object.keys(obj).join(', ')}`
	);
}

/**
 * Normalizes a raw value into a list of records for native field mapping.
 * Accepts arrays directly, common envelope keys, or a single object (treated
 * as a one-record list).
 */
function normalizeRecordList(raw: unknown): Record<string, unknown>[] {
	if (typeof raw === 'string') {
		const parsed = tryParseJson(raw);
		if (parsed !== null) return normalizeRecordList(parsed);
		return [];
	}

	if (Array.isArray(raw)) {
		return raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
	}

	if (!raw || typeof raw !== 'object') return [];

	const obj = raw as Record<string, unknown>;
	for (const key of ['items', 'results', 'records', 'data', 'output', 'response', 'payload', 'messages', 'issues']) {
		const value = obj[key];
		if (Array.isArray(value)) {
			return value.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
		}
	}

	return [obj];
}

function mapNativeRecord(record: Record<string, unknown>, mapping: ComposioFieldMapping): ItemData {
	const name = readString(record, mapping.nameField);
	const urlKey = mapping.urlField;
	const url = urlKey ? readString(record, urlKey) : '';

	const description = mapping.descriptionField ? readString(record, mapping.descriptionField) : '';
	const category = mapping.categoryField ? readString(record, mapping.categoryField) : '';
	const content = mapping.contentField ? readString(record, mapping.contentField) : undefined;
	const brand = mapping.brandField ? readString(record, mapping.brandField) : undefined;

	const tags: string[] = [];
	if (mapping.tagsField) {
		const raw = readField(record, mapping.tagsField);
		if (Array.isArray(raw)) {
			for (const t of raw) {
				if (typeof t === 'string' && t.trim()) tags.push(t.trim());
			}
		} else if (typeof raw === 'string' && raw.trim()) {
			for (const t of raw.split(',')) {
				const trimmed = t.trim();
				if (trimmed) tags.push(trimmed);
			}
		}
	}

	const images: string[] = [];
	if (mapping.imageField) {
		const raw = readField(record, mapping.imageField);
		// Security: only keep http(s) image URLs (see sanitizeHttpUrl).
		if (Array.isArray(raw)) {
			for (const img of raw) {
				if (typeof img === 'string') {
					const safe = sanitizeHttpUrl(img);
					if (safe) images.push(safe);
				}
			}
		} else if (typeof raw === 'string') {
			const safe = sanitizeHttpUrl(raw);
			if (safe) images.push(safe);
		}
	}

	return {
		name: (name || '').trim(),
		description: (description || '').trim(),
		// Security: reject non-http(s) source URLs (javascript:/data:/…).
		source_url: sanitizeHttpUrl(url || ''),
		markdown: content,
		category: (category || '').trim(),
		tags,
		brand: brand?.trim() || undefined,
		images: images.length > 0 ? images : undefined
	};
}

function isNonEmptyItem(item: ItemData): boolean {
	return typeof item.name === 'string' && item.name.trim().length > 0;
}

/** Reads a field by a dot-separated path (e.g. `profile.name` or `fields.0.title`). */
function readField(record: Record<string, unknown>, path: string): unknown {
	if (!path) return undefined;
	const parts = path
		.split('.')
		.map((p) => p.trim())
		.filter(Boolean);
	let current: unknown = record;
	for (const part of parts) {
		if (current == null) return undefined;
		// Security (prototype-pollution): both the mapping path and the live
		// records are attacker-controlled (Composio tool output). Refuse to walk
		// into `__proto__` / `constructor` / `prototype` so a crafted path or a
		// record key literally named `__proto__` can't escape onto the prototype
		// chain and leak built-in members into item fields. No legitimate field
		// uses these names, so behavior is unchanged for valid input.
		if (part === '__proto__' || part === 'prototype' || part === 'constructor') return undefined;
		if (Array.isArray(current)) {
			const idx = Number(part);
			if (!Number.isInteger(idx)) return undefined;
			current = current[idx];
			continue;
		}
		if (typeof current !== 'object') return undefined;
		// Read own properties only — never inherited members off the prototype.
		current = Object.prototype.hasOwnProperty.call(current, part)
			? (current as Record<string, unknown>)[part]
			: undefined;
	}
	return current;
}

function readString(record: Record<string, unknown>, path: string): string {
	const value = readField(record, path);
	return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function tryParseJson(str: string): unknown {
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}

/**
 * Security (open-redirect / stored-XSS): `source_url` and `images` come straight
 * from attacker-controlled Composio tool output (Gmail bodies, GitHub issues,
 * Notion pages) and are later rendered as `href` / `<img src>`. Allow only
 * http(s) URLs — anything else (`javascript:`, `data:`, relative junk) is
 * dropped to an empty string. Mirrors the canonical `httpUrl` schema used by the
 * CLI pipeline (`packages/plugin/src/cli-pipeline/workspace.ts`). Legitimate
 * http(s) URLs pass through unchanged.
 */
function sanitizeHttpUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	try {
		const u = new URL(trimmed);
		return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : '';
	} catch {
		return '';
	}
}

function parseItems(rawItems: ComposioOutputItem[]): ItemData[] {
	const items: ItemData[] = [];

	for (const raw of rawItems) {
		if (!raw || typeof raw !== 'object') continue;
		if (!raw.name || typeof raw.name !== 'string') continue;

		// Security: source_url / images are attacker-controlled tool output that
		// the platform later renders as href / <img src>. Allow only http(s).
		const rawUrl = typeof raw.url === 'string' ? raw.url : typeof raw.source_url === 'string' ? raw.source_url : '';
		const safeImages = Array.isArray(raw.images)
			? raw.images.reduce<string[]>((acc, i) => {
					if (typeof i === 'string') {
						const safe = sanitizeHttpUrl(i);
						if (safe) acc.push(safe);
					}
					return acc;
				}, [])
			: undefined;

		const item: ItemData = {
			name: raw.name.trim(),
			description: typeof raw.description === 'string' ? raw.description.trim() : '',
			source_url: sanitizeHttpUrl(rawUrl),
			markdown: typeof raw.content === 'string' ? raw.content : undefined,
			category: typeof raw.category === 'string' ? raw.category.trim() : '',
			tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
			brand: typeof raw.brand === 'string' ? raw.brand.trim() : undefined,
			images: safeImages
		};

		items.push(item);
	}

	return items;
}

function parseCategories(rawCategories: ComposioToolOutput['categories'], items: ItemData[]): Category[] {
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

function parseTags(rawTags: ComposioToolOutput['tags'], items: ItemData[]): Tag[] {
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

function parseBrands(rawBrands: ComposioToolOutput['brands'], items: ItemData[]): Brand[] {
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

/** Deduplicates new items against existing items by name (case-insensitive). */
export function deduplicateItems(newItems: ItemData[], existingItemNames: string[]): ItemData[] {
	const existingSet = new Set(existingItemNames.map((n) => n.toLowerCase().trim()));
	return newItems.filter((item) => !existingSet.has(item.name.toLowerCase().trim()));
}

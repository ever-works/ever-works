import { slugify, unslugify } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

type ReadFn = (path: string) => Promise<string>;
type WriteFn = (path: string, content: string) => Promise<void>;

interface TaxonomyEntry {
	id: string;
	name: string;
	logo_url?: string;
}

/**
 * After a file is written to the workspace, extract category/tags/brand
 * from its JSON content and merge them into the corresponding `_meta/` files
 * with case-insensitive dedup.
 *
 * Best-effort: callers should wrap in try/catch.
 */
export async function syncTaxonomyFromFile(
	readFn: ReadFn,
	writeFn: WriteFn,
	filePath: string,
	content: string
): Promise<void> {
	if (isMetaPath(filePath) || !filePath.endsWith('.json')) {
		return;
	}

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(content);
	} catch {
		return;
	}

	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return;
	}

	const metaDir = resolveMetaDir(filePath);

	await syncCategories(readFn, writeFn, metaDir, data);
	await syncTags(readFn, writeFn, metaDir, data);
	await syncBrands(readFn, writeFn, metaDir, data);
}

// ── Field extractors ────────────────────────────────────────────────

function syncCategories(readFn: ReadFn, writeFn: WriteFn, metaDir: string, data: Record<string, unknown>) {
	const raw = Array.isArray(data.category) ? data.category : data.category ? [data.category] : [];
	const names = raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
	if (names.length === 0) return Promise.resolve();
	return mergeEntries(readFn, writeFn, `${metaDir}/categories.json`, names);
}

function syncTags(readFn: ReadFn, writeFn: WriteFn, metaDir: string, data: Record<string, unknown>) {
	if (!Array.isArray(data.tags)) return Promise.resolve();
	const names = data.tags.map(extractTagName).filter((n) => n.trim() !== '');
	if (names.length === 0) return Promise.resolve();
	return mergeEntries(readFn, writeFn, `${metaDir}/tags.json`, names);
}

function syncBrands(readFn: ReadFn, writeFn: WriteFn, metaDir: string, data: Record<string, unknown>) {
	if (!data.brand) return Promise.resolve();

	const brandName = extractBrandName(data.brand);
	if (!brandName.trim()) return Promise.resolve();

	const brandLogo = extractBrandLogo(data.brand, data.brand_logo_url);
	return mergeBrandEntry(readFn, writeFn, `${metaDir}/brands.json`, brandName, brandLogo);
}

function extractTagName(tag: unknown): string {
	if (typeof tag === 'string') return tag;
	if (typeof tag === 'object' && tag !== null && 'name' in tag) {
		return String((tag as { name: unknown }).name);
	}
	return '';
}

function extractBrandName(brand: unknown): string {
	if (typeof brand === 'string') return brand;
	if (typeof brand === 'object' && brand !== null && 'name' in brand) {
		return String((brand as { name: unknown }).name);
	}
	return '';
}

function extractBrandLogo(brand: unknown, fallbackLogo: unknown): string | undefined {
	// Security: logo URLs originate from LLM-generated content (potentially
	// influenced by hostile web pages). Validate each candidate against the
	// shared SSRF guard (blocks private IPs, cloud-metadata endpoints, etc.)
	// and restrict to HTTPS-only before storing in the workspace metadata file.
	if (typeof brand === 'object' && brand !== null && 'logo_url' in brand) {
		const url = (brand as { logo_url?: unknown }).logo_url;
		if (typeof url === 'string' && isSafeLogo(url)) return url;
	}
	if (typeof fallbackLogo === 'string' && isSafeLogo(fallbackLogo)) return fallbackLogo;
	return undefined;
}

/**
 * Returns true only if `url` is an HTTPS URL that passes the SSRF lexical
 * guard (no private IPs, no cloud-metadata endpoints, no non-HTTP schemes).
 * Logo URLs written to workspace metadata must always be HTTPS; plain HTTP
 * is rejected to prevent potential server-side downgrade exploitation.
 */
function isSafeLogo(url: string): boolean {
	if (!isSafeWebhookUrl(url)) return false;
	// isSafeWebhookUrl allows both http: and https:; we restrict logos to https: only.
	try {
		return new URL(url).protocol === 'https:';
	} catch {
		return false;
	}
}

// ── Path helpers ────────────────────────────────────────────────────

function isMetaPath(filePath: string): boolean {
	return filePath.includes('/_meta/') || filePath.includes('\\_meta\\');
}

function resolveMetaDir(filePath: string): string {
	// Handle both POSIX (`/`) and Windows (`\`) separators — fs.watch on
	// Windows surfaces paths with backslashes.
	const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
	const dir = lastSep >= 0 ? filePath.slice(0, lastSep) : '.';
	return `${dir}/_meta`;
}

// ── Merge logic ─────────────────────────────────────────────────────

async function mergeEntries(readFn: ReadFn, writeFn: WriteFn, filePath: string, newNames: string[]): Promise<void> {
	const existing = await readTaxonomyFile(readFn, filePath);
	const seen = new Set(existing.map((e) => e.name.toLowerCase().trim()));
	let added = false;

	for (const name of newNames) {
		const key = name.toLowerCase().trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		existing.push({ id: slugify(name) || key, name: unslugify(name) });
		added = true;
	}

	if (added) {
		await writeFn(filePath, JSON.stringify(existing, null, 2));
	}
}

async function mergeBrandEntry(
	readFn: ReadFn,
	writeFn: WriteFn,
	filePath: string,
	brandName: string,
	logoUrl?: string
): Promise<void> {
	const existing = await readTaxonomyFile(readFn, filePath);
	const seen = new Set(existing.map((e) => e.name.toLowerCase().trim()));
	const key = brandName.toLowerCase().trim();

	if (!key || seen.has(key)) return;

	const entry: TaxonomyEntry = { id: slugify(brandName) || key, name: unslugify(brandName) };
	if (logoUrl) entry.logo_url = logoUrl;

	existing.push(entry);
	await writeFn(filePath, JSON.stringify(existing, null, 2));
}

async function readTaxonomyFile(readFn: ReadFn, filePath: string): Promise<TaxonomyEntry[]> {
	try {
		const raw = await readFn(filePath);
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

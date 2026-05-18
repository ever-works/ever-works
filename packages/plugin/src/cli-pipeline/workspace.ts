import * as fs from 'fs/promises';
// All path construction in this module uses `path.posix.join` so the produced
// strings are stable across platforms (Node accepts forward slashes on
// Windows just fine for filesystem ops). Tests assert on POSIX paths.
import * as path from 'path/posix';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Brand, Category, ItemData, Tag } from '../common/index.js';
import type { ReferenceEntry } from '../pipeline/references.js';
import { jsonrepair, normalizeItemTags, slugify, validateRequiredItemFields } from '../pipeline/workspace-utils.js';

/**
 * M-26: validation schema for items produced by CLI agents
 * (claude-code, codex, gemini, opencode). Before this, only the four
 * required fields were checked; the rest of the item flowed through
 * unbounded — letting a prompt-injected model insert oversized payloads,
 * unicode tricks, or attacker-chosen URLs into fields the platform later
 * renders. Schema is intentionally permissive on shape (most fields are
 * optional and free-form, by design of the CLI plugin contract) but
 * enforces length caps and URL schemes everywhere a string could become
 * an `href` / image src.
 */
const ITEM_STRING_MAX = 16 * 1024;
const ITEM_LONG_STRING_MAX = 64 * 1024;
const ITEM_TAG_MAX = 64;

const httpUrl = z
	.string()
	.max(2048)
	.refine(
		(v) => {
			try {
				const u = new URL(v);
				return u.protocol === 'http:' || u.protocol === 'https:';
			} catch {
				return false;
			}
		},
		{ message: 'url must use http(s) scheme' }
	);

const stringOrNullish = z.union([z.string().max(ITEM_STRING_MAX), z.null(), z.undefined()]);

const cliItemSchema = z
	.object({
		name: z.string().min(1).max(ITEM_STRING_MAX),
		description: z.string().min(1).max(ITEM_LONG_STRING_MAX),
		source_url: httpUrl,
		category: z.union([z.string().max(ITEM_STRING_MAX), z.array(z.string().max(ITEM_STRING_MAX)).max(64)]),
		tags: z.array(z.string().max(ITEM_TAG_MAX)).max(256).optional(),
		images: z.array(httpUrl).max(64).optional(),
		image: stringOrNullish.optional(),
		brand: stringOrNullish.optional()
		// Free-form metadata — accept but cap.
	})
	.catchall(z.unknown())
	.transform((item) => {
		// Cap any unknown top-level string fields silently to avoid letting
		// 100 MB strings through via `metadata: { huge: "..." }`. This is a
		// last-resort cap; explicit fields above already constrain expected paths.
		for (const [k, v] of Object.entries(item)) {
			if (typeof v === 'string' && v.length > ITEM_LONG_STRING_MAX) {
				(item as Record<string, unknown>)[k] = v.slice(0, ITEM_LONG_STRING_MAX);
			}
		}
		return item;
	});

export { collectMetadataFromItems, slugify, unslugify } from '../pipeline/workspace-utils.js';

export interface CliPipelineLogger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
}

export interface WorkspaceMetadataSeed {
	work?: { name: string; description?: string };
	request?: { prompt?: string; name?: string };
	categories?: readonly Category[];
	tags?: readonly Tag[];
	brands?: readonly Brand[];
	references?: readonly ReferenceEntry[];
}

const WRITE_CONCURRENCY = 64;

function deduplicateSlug(slug: string, existingSlugs: Set<string>): string {
	if (!existingSlugs.has(slug)) {
		return slug;
	}

	let index = 2;
	while (existingSlugs.has(`${slug}-${index}`)) {
		index++;
	}
	return `${slug}-${index}`;
}

async function parallelBatch<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
	const results: T[] = [];
	for (let i = 0; i < tasks.length; i += concurrency) {
		const batch = tasks.slice(i, i + concurrency);
		results.push(...(await Promise.all(batch.map((fn) => fn()))));
	}
	return results;
}

export function getWorkspacePath(baseTempDir: string, userId: string, workId: string): string {
	return path.join(baseTempDir, userId, workId);
}

export async function createWorkspace(baseTempDir: string, userId: string, workId: string): Promise<string> {
	const workspaceRoot = getWorkspacePath(baseTempDir, userId, workId);
	await fs.mkdir(workspaceRoot, { recursive: true });
	const workspacePath = await fs.mkdtemp(path.join(workspaceRoot, 'run-'));
	await fs.mkdir(path.join(workspacePath, '_meta'), { recursive: true });
	return workspacePath;
}

export async function seedExistingItems(workspacePath: string, items: readonly ItemData[]): Promise<void> {
	if (!items.length) return;

	const metaDir = path.join(workspacePath, '_meta');
	const usedSlugs = new Set<string>();
	const seededManifest: Record<string, string> = {};
	const indexLines: string[] = [];
	const itemWrites: Array<() => Promise<void>> = [];

	for (const item of items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const fileName = `${slug}.json`;
		const content = JSON.stringify(item, null, 2);
		seededManifest[fileName] = createHash('sha256').update(content).digest('hex');
		indexLines.push(JSON.stringify({ slug, name: item.name, source_url: item.source_url }));

		itemWrites.push(() => fs.writeFile(path.join(workspacePath, fileName), content, 'utf-8'));
	}

	await parallelBatch(itemWrites, WRITE_CONCURRENCY);

	await Promise.all([
		fs.writeFile(path.join(metaDir, 'seeded.json'), JSON.stringify(seededManifest), 'utf-8'),
		fs.writeFile(path.join(metaDir, 'existing-items.jsonl'), indexLines.join('\n') + '\n', 'utf-8')
	]);
}

export async function seedMetadata(workspacePath: string, metadata: WorkspaceMetadataSeed): Promise<void> {
	const metaDir = path.join(workspacePath, '_meta');

	if (metadata.work) {
		await fs.writeFile(path.join(metaDir, 'work.json'), JSON.stringify(metadata.work, null, 2), 'utf-8');
	}

	if (metadata.request) {
		await fs.writeFile(path.join(metaDir, 'request.json'), JSON.stringify(metadata.request, null, 2), 'utf-8');
	}

	if (metadata.categories?.length) {
		await fs.writeFile(
			path.join(metaDir, 'categories.json'),
			JSON.stringify(metadata.categories, null, 2),
			'utf-8'
		);
	}

	if (metadata.tags?.length) {
		await fs.writeFile(path.join(metaDir, 'tags.json'), JSON.stringify(metadata.tags, null, 2), 'utf-8');
	}

	if (metadata.brands?.length) {
		await fs.writeFile(path.join(metaDir, 'brands.json'), JSON.stringify(metadata.brands, null, 2), 'utf-8');
	}

	if (metadata.references?.length) {
		const lines = metadata.references.map((reference) => JSON.stringify(reference)).join('\n');
		await fs.writeFile(path.join(metaDir, 'references.jsonl'), lines + '\n', 'utf-8');
	}
}

export async function readGeneratedItems(
	workspacePath: string,
	logger?: Pick<CliPipelineLogger, 'warn'>
): Promise<ItemData[]> {
	let entries: string[];
	try {
		const dirEntries = await fs.readdir(workspacePath, { withFileTypes: true });
		entries = dirEntries.filter((e) => !e.isDirectory() && e.name.endsWith('.json')).map((e) => e.name);
	} catch {
		logger?.warn('Could not read workspace work');
		return [];
	}

	if (entries.length === 0) return [];

	let seededHashes: Record<string, string> = {};
	try {
		const manifestContent = await fs.readFile(path.join(workspacePath, '_meta', 'seeded.json'), 'utf-8');
		seededHashes = JSON.parse(manifestContent) as Record<string, string>;
	} catch {
		// No manifest — treat all files as new.
	}

	const results = await Promise.all(
		entries.map(async (fileName) => {
			try {
				const content = await fs.readFile(path.join(workspacePath, fileName), 'utf-8');
				const seededHash = seededHashes[fileName];

				if (seededHash) {
					const currentHash = createHash('sha256').update(content).digest('hex');
					if (currentHash === seededHash) {
						return null;
					}
				}

				let data: Record<string, unknown>;
				try {
					data = JSON.parse(content) as Record<string, unknown>;
				} catch {
					const repaired = jsonrepair(content);
					data = JSON.parse(repaired) as Record<string, unknown>;
					logger?.warn(`Repaired malformed JSON in ${fileName}`);
				}

				if (!validateRequiredItemFields(data)) {
					logger?.warn(
						`Skipping ${fileName}: missing required fields (name, description, source_url, category)`
					);
					return null;
				}

				// M-26: full-shape validation. `validateRequiredItemFields`
				// only checks presence of the four required fields; the Zod
				// schema additionally enforces field types, URL schemes
				// (no `javascript:`), and length caps so a malicious CLI
				// model output can't sneak oversized fields or unsafe URLs
				// into the rendered site.
				const parsed = cliItemSchema.safeParse(data);
				if (!parsed.success) {
					logger?.warn(
						`Skipping ${fileName}: failed CLI item schema (M-26): ${parsed.error.issues
							.slice(0, 3)
							.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
							.join('; ')}`
					);
					return null;
				}
				const validated = parsed.data as Record<string, unknown>;

				normalizeItemTags(validated);
				return validated as unknown as ItemData;
			} catch (err) {
				logger?.warn(`Skipping ${fileName}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
				return null;
			}
		})
	);

	return results.filter((item: ItemData | null): item is ItemData => item !== null);
}

/**
 * L-32: defensive guard against catastrophic `fs.rm({ recursive: true, force: true })`
 * if a caller ever passes an empty string, `/`, or a path that isn't actually under
 * the configured temp dir. `createWorkspace` is the only safe producer, but a future
 * caller could pass a tampered string from a payload — refusing anything that
 * resolves to a short / non-temp path is much cheaper than the worst case.
 *
 * Pass `baseTempDir` when you can; when you can't, we still refuse `/`, `''`,
 * the root drive on Windows, and any path with fewer than 5 segments.
 */
export async function cleanupWorkspace(workspacePath: string, baseTempDir?: string): Promise<void> {
	try {
		if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
			return;
		}
		const resolved = path.resolve(workspacePath);
		// Refuse root / near-root paths regardless of OS.
		if (resolved === '/' || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
			return;
		}
		// If a baseTempDir is supplied, the workspace MUST be inside it.
		if (baseTempDir) {
			const baseResolved = path.resolve(baseTempDir);
			const relative = path.relative(baseResolved, resolved);
			if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
				return;
			}
		}
		await fs.rm(resolved, { recursive: true, force: true });
	} catch {
		// Cleanup failures are non-fatal.
	}
}

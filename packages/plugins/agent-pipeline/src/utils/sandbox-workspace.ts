import { mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ItemData, DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import { slugify, validateRequiredItemFields, normalizeItemTags } from '@ever-works/plugin';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
}

/** Max concurrent file writes to avoid fd exhaustion. */
const WRITE_CONCURRENCY = 64;

const BASE_DIR = join(tmpdir(), 'agent-pipeline');

/**
 * Deduplicate slugs by appending an index for collisions.
 */
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

/**
 * Run async tasks with bounded concurrency.
 */
async function parallelBatch<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
	const results: T[] = [];
	for (let i = 0; i < tasks.length; i += concurrency) {
		const batch = tasks.slice(i, i + concurrency);
		results.push(...(await Promise.all(batch.map((fn) => fn()))));
	}
	return results;
}

/**
 * Build the workspace path for a given user and directory.
 */
export function getWorkspacePath(userId: string, directoryId: string): string {
	return join(BASE_DIR, userId, directoryId);
}

/**
 * Create a workspace directory on disk and seed it with existing items and metadata.
 *
 * - Existing items are written as individual `.json` files so the agent can
 *   read, search across, and update them.
 * - A compact `_meta/existing-items.jsonl` index (slug, name, source_url)
 *   is also written so the agent can grep for duplicates without reading
 *   full item files (context-safe).
 * - A `_meta/seeded.json` manifest records which files were seeded so that
 *   collection can skip unchanged ones.
 * - All writes are parallelized in batches.
 *
 * Returns the absolute workspace path.
 */
export async function createWorkspace(
	userId: string,
	directoryId: string,
	existing: ExistingItems,
	directory: DirectoryReference,
	request: GenerationRequest
): Promise<string> {
	const workspacePath = getWorkspacePath(userId, directoryId);
	const metaDir = join(workspacePath, '_meta');

	await mkdir(metaDir, { recursive: true });

	// ── Seed existing items as individual files ──────────────────────
	const seededFiles: string[] = [];
	const usedSlugs = new Set<string>();
	const itemWrites: (() => Promise<void>)[] = [];
	const indexLines: string[] = [];

	for (const item of existing.items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const fileName = `${slug}.json`;
		seededFiles.push(fileName);
		indexLines.push(JSON.stringify({ slug, name: item.name, source_url: item.source_url }));

		itemWrites.push(() => writeFile(join(workspacePath, fileName), JSON.stringify(item, null, 2), 'utf-8'));
	}

	// Write item files in parallel batches
	if (itemWrites.length > 0) {
		await parallelBatch(itemWrites, WRITE_CONCURRENCY);
	}

	// ── Metadata writes (all in parallel) ────────────────────────────
	const metaWrites: Promise<void>[] = [];

	metaWrites.push(
		writeFile(
			join(metaDir, 'directory.json'),
			JSON.stringify({ name: directory.name, description: directory.description }, null, 2),
			'utf-8'
		)
	);

	metaWrites.push(
		writeFile(
			join(metaDir, 'request.json'),
			JSON.stringify({ prompt: request.prompt, name: request.name }, null, 2),
			'utf-8'
		)
	);

	// Seeded file manifest — used by collectItemsFromWorkspace to skip unchanged files
	metaWrites.push(writeFile(join(metaDir, 'seeded.json'), JSON.stringify(seededFiles), 'utf-8'));

	// Compact JSONL index for dedup grep (slug, name, source_url only)
	if (indexLines.length > 0) {
		metaWrites.push(writeFile(join(metaDir, 'existing-items.jsonl'), indexLines.join('\n') + '\n', 'utf-8'));
	}

	if (existing.categories?.length) {
		metaWrites.push(
			writeFile(join(metaDir, 'categories.json'), JSON.stringify(existing.categories, null, 2), 'utf-8')
		);
	}

	if (existing.tags?.length) {
		metaWrites.push(writeFile(join(metaDir, 'tags.json'), JSON.stringify(existing.tags, null, 2), 'utf-8'));
	}

	if (existing.brands?.length) {
		metaWrites.push(writeFile(join(metaDir, 'brands.json'), JSON.stringify(existing.brands, null, 2), 'utf-8'));
	}

	await Promise.all(metaWrites);

	return workspacePath;
}

/**
 * Collect generated/modified items from a workspace directory.
 *
 * Reads `_meta/seeded.json` to know which files were seeded at setup.
 * Then uses file mtime to skip seeded files the agent never touched,
 * only reading new files and files the agent actually modified.
 *
 * Validates required fields and normalizes tags.
 */
export async function collectItemsFromWorkspace(workspacePath: string, logger?: Logger): Promise<ItemData[]> {
	let entries: string[];
	try {
		entries = await readdir(workspacePath);
	} catch {
		logger?.warn('Could not read workspace directory');
		return [];
	}

	const fileNames = entries.filter((f) => f.endsWith('.json'));

	if (fileNames.length === 0) {
		logger?.warn('No JSON files found in workspace');
		return [];
	}

	// Load seeded manifest and its mtime to detect which files the agent touched
	let seededSet = new Set<string>();
	let seedTime = 0;
	try {
		const manifestContent = await readFile(join(workspacePath, '_meta', 'seeded.json'), 'utf-8');
		seededSet = new Set(JSON.parse(manifestContent) as string[]);
		const manifestStat = await stat(join(workspacePath, '_meta', 'seeded.json'));
		seedTime = manifestStat.mtimeMs;
	} catch {
		// No manifest — treat all files as new (first run or empty existing)
	}

	// Read files in parallel, skipping unchanged seeded files
	const results = await Promise.all(
		fileNames.map(async (fileName) => {
			try {
				// If this was a seeded file, check if the agent modified it
				if (seededSet.has(fileName) && seedTime > 0) {
					const fileStat = await stat(join(workspacePath, fileName));
					if (fileStat.mtimeMs <= seedTime) {
						return null; // Unchanged seeded file — caller already has it
					}
				}

				const content = await readFile(join(workspacePath, fileName), 'utf-8');
				const data = JSON.parse(content);

				if (!validateRequiredItemFields(data)) {
					logger?.warn(
						`Skipping ${fileName}: missing required fields (name, description, source_url, category)`
					);
					return null;
				}

				normalizeItemTags(data);
				return data as ItemData;
			} catch (err) {
				logger?.warn(`Skipping ${fileName}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
				return null;
			}
		})
	);

	return results.filter((item): item is ItemData => item !== null);
}

/**
 * Remove the workspace directory for a given user and directory.
 */
export async function cleanupWorkspace(userId: string, directoryId: string): Promise<void> {
	const workspacePath = getWorkspacePath(userId, directoryId);
	await rm(workspacePath, { recursive: true, force: true });
}

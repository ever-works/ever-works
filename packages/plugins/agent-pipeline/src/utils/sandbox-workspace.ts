import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ItemData, WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
import { slugify, validateRequiredItemFields, normalizeItemTags, jsonrepair } from '@ever-works/plugin';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
}

const WRITE_CONCURRENCY = 64;

const BASE_DIR = join(tmpdir(), 'agent-pipeline');

export function stringifyWorkspaceItem(item: ItemData): string {
	return JSON.stringify(item, null, 2);
}

export function hashWorkspaceContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

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

async function parallelBatch<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
	const results: T[] = [];
	for (let i = 0; i < tasks.length; i += concurrency) {
		const batch = tasks.slice(i, i + concurrency);
		results.push(...(await Promise.all(batch.map((fn) => fn()))));
	}
	return results;
}

// Security: workspace path components (userId, workId, runId) must be opaque
// identifiers — database IDs / UUIDs — never path fragments. Reject anything
// outside the safe-identifier set so an attacker-controlled `..`, `/` or `\`
// component cannot relocate the workspace (and its later `rm -rf`) outside
// BASE_DIR. Legitimate UUID/slug IDs pass unchanged.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
	if (typeof value !== 'string' || !SAFE_PATH_SEGMENT.test(value)) {
		throw new Error(`Invalid ${label}: must match [A-Za-z0-9_-]+`);
	}
}

export function getWorkspacePath(userId: string, workId: string, runId: string): string {
	// Security: validate identifiers before they reach `join` (which would
	// normalize `..` segments and escape BASE_DIR).
	assertSafePathSegment(userId, 'userId');
	assertSafePathSegment(workId, 'workId');
	assertSafePathSegment(runId, 'runId');

	const workspacePath = join(BASE_DIR, userId, `${workId}-${runId}`);

	// Security: defense-in-depth — assert the resolved path stays under BASE_DIR.
	const resolvedBase = resolve(BASE_DIR);
	const resolvedPath = resolve(workspacePath);
	if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + sep)) {
		throw new Error('Resolved workspace path escapes the sandbox base directory');
	}

	return workspacePath;
}

/**
 * Create workspace, seed existing items as individual files + JSONL dedup index + hash manifest.
 */
export async function createWorkspace(
	userId: string,
	workId: string,
	existing: ExistingItems,
	work: WorkReference,
	request: GenerationRequest
): Promise<string> {
	const workspacePath = getWorkspacePath(userId, workId, randomUUID());
	const metaDir = join(workspacePath, '_meta');

	await mkdir(metaDir, { recursive: true });

	const seededManifest: Record<string, string> = {};
	const usedSlugs = new Set<string>();
	const itemWrites: (() => Promise<void>)[] = [];
	const indexLines: string[] = [];

	// Security: re-slugify `item.slug` (not just the `item.name` fallback) before
	// using it as a filename. `item.slug` is tenant-controlled and was previously
	// used raw, so a crafted slug like `../../evil` survived `path.join`'s `..`
	// normalization and escaped `workspacePath`. `slugify` strips `/`, `\` and `.`,
	// and the empty-result fallback guarantees a non-escaping, non-empty filename.
	const resolvedWorkspace = resolve(workspacePath);
	for (const item of existing.items) {
		const baseSlug = slugify(item.slug || '') || slugify(item.name) || 'item';
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const fileName = `${slug}.json`;
		const content = stringifyWorkspaceItem(item);
		seededManifest[fileName] = hashWorkspaceContent(content);
		indexLines.push(JSON.stringify({ slug, name: item.name, source_url: item.source_url }));

		// Security: defense-in-depth — confirm the seed file stays inside the workspace.
		const itemPath = join(workspacePath, fileName);
		if (resolve(itemPath) !== resolvedWorkspace && !resolve(itemPath).startsWith(resolvedWorkspace + sep)) {
			throw new Error(`Seed item path escapes the workspace: ${fileName}`);
		}

		itemWrites.push(() => writeFile(itemPath, content, 'utf-8'));
	}

	if (itemWrites.length > 0) {
		await parallelBatch(itemWrites, WRITE_CONCURRENCY);
	}

	const metaWrites: Promise<void>[] = [];

	metaWrites.push(
		writeFile(
			join(metaDir, 'work.json'),
			JSON.stringify({ name: work.name, description: work.description }, null, 2),
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

	metaWrites.push(writeFile(join(metaDir, 'seeded.json'), JSON.stringify(seededManifest), 'utf-8'));

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

	if (existing.references?.length) {
		metaWrites.push(
			writeFile(
				join(metaDir, 'references.jsonl'),
				existing.references.map((reference) => JSON.stringify(reference)).join('\n') + '\n',
				'utf-8'
			)
		);
	}

	await Promise.all(metaWrites);

	return workspacePath;
}

/**
 * Collect generated/modified items from workspace. Skips unchanged seeded files via content hash.
 */
export async function collectItemsFromWorkspace(workspacePath: string, logger?: Logger): Promise<ItemData[]> {
	let entries: string[];
	try {
		entries = await readdir(workspacePath);
	} catch {
		logger?.warn('Could not read workspace work');
		return [];
	}

	const fileNames = entries.filter((f) => f.endsWith('.json'));

	if (fileNames.length === 0) {
		logger?.warn('No JSON files found in workspace');
		return [];
	}

	let seededHashes: Record<string, string> = {};
	try {
		const manifestContent = await readFile(join(workspacePath, '_meta', 'seeded.json'), 'utf-8');
		seededHashes = JSON.parse(manifestContent) as Record<string, string>;
	} catch {
		// No manifest — treat all files as new
	}

	const results = await Promise.all(
		fileNames.map(async (fileName) => {
			try {
				const content = await readFile(join(workspacePath, fileName), 'utf-8');

				const seededHash = seededHashes[fileName];
				if (seededHash) {
					const currentHash = hashWorkspaceContent(content);
					if (currentHash === seededHash) {
						return null;
					}
				}
				let data;
				try {
					data = JSON.parse(content);
				} catch {
					const repaired = jsonrepair(content);
					data = JSON.parse(repaired);
					logger?.warn(`Repaired malformed JSON in ${fileName}`);
				}

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

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
	await rm(workspacePath, { recursive: true, force: true });

	// Remove parent user work if now empty
	const userDir = dirname(workspacePath);
	try {
		const remaining = await readdir(userDir);
		if (remaining.length === 0) {
			await rm(userDir, { recursive: true, force: true });
		}
	} catch {
		// Already gone — ignore
	}
}

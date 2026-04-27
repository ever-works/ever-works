import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ItemData, DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';
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

export function getWorkspacePath(userId: string, directoryId: string, runId: string): string {
	return join(BASE_DIR, userId, `${directoryId}-${runId}`);
}

/**
 * Create workspace, seed existing items as individual files + JSONL dedup index + hash manifest.
 */
export async function createWorkspace(
	userId: string,
	directoryId: string,
	existing: ExistingItems,
	directory: DirectoryReference,
	request: GenerationRequest
): Promise<string> {
	const workspacePath = getWorkspacePath(userId, directoryId, randomUUID());
	const metaDir = join(workspacePath, '_meta');

	await mkdir(metaDir, { recursive: true });

	const seededManifest: Record<string, string> = {};
	const usedSlugs = new Set<string>();
	const itemWrites: (() => Promise<void>)[] = [];
	const indexLines: string[] = [];

	for (const item of existing.items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const fileName = `${slug}.json`;
		const content = stringifyWorkspaceItem(item);
		seededManifest[fileName] = hashWorkspaceContent(content);
		indexLines.push(JSON.stringify({ slug, name: item.name, source_url: item.source_url }));

		itemWrites.push(() => writeFile(join(workspacePath, fileName), content, 'utf-8'));
	}

	if (itemWrites.length > 0) {
		await parallelBatch(itemWrites, WRITE_CONCURRENCY);
	}

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
		logger?.warn('Could not read workspace directory');
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

	// Remove parent user directory if now empty
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

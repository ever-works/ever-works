import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'node:crypto';
import type { Brand, Category, ItemData, Tag } from '../common/index.js';
import {
	collectMetadataFromItems,
	jsonrepair,
	normalizeItemTags,
	slugify,
	validateRequiredItemFields
} from '../pipeline/workspace-utils.js';

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

				normalizeItemTags(data);
				return data as unknown as ItemData;
			} catch (err) {
				logger?.warn(`Skipping ${fileName}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
				return null;
			}
		})
	);

	return results.filter((item: ItemData | null): item is ItemData => item !== null);
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
	try {
		await fs.rm(workspacePath, { recursive: true, force: true });
	} catch {
		// Cleanup failures are non-fatal.
	}
}
